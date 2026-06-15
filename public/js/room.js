// WebRTC + Cloudflare Realtime + Durable Objects WebSocket の統合管理

const WORKER_URL = ''; // _worker.js が同一オリジンでプロキシするため相対パスで良い

export class RoomClient {
  constructor({ roomId, sessionId, token, userMeta, onEvent }) {
    this.roomId = roomId;
    this.sessionId = sessionId;
    this.token = token;
    this.userMeta = userMeta; // { name, voice, icon, clientId }
    this.onEvent = onEvent;

    this.ws = null;
    this.peerConnection = null;
    this.localStream = null;
    this.peers = new Map(); // clientId → metadata
    this.audioElements = new Map(); // sessionId → HTMLAudioElement
    this.speakingDetector = null;

    // 購読キュー：WebRTCはオファー/アンサーを1つずつしか処理できないため
    // 複数ピアへの購読をシリアル実行するためのキュー
    this._taskQueue = [];
    this._subscribeRunning = false;
    // ontrack 発火待ちのキュー（{ peerSessionId, resolve }）
    this._pendingTracks = [];
    // WebSocket keepalive ping タイマー
    this._pingInterval = null;
  }

  async connect(processedStream) {
    this.localStream = processedStream;

    // 1. Durable Object WebSocket 接続
    await this._connectSignaling();

    // 2. Cloudflare Realtime にローカル音声をパブリッシュ
    await this._publishLocalTrack();
  }

  async _connectSignaling() {
    // WebSocketはCORSの対象外なので workers.dev に直接接続（Braveでも問題なし）
    const wsUrl = new URL(`https://voice-chat-worker.legarsi-18k.workers.dev/api/rooms/${this.roomId}/ws`);
    wsUrl.protocol = 'wss:';
    wsUrl.searchParams.set('token', this.token);
    wsUrl.searchParams.set('name', this.userMeta.name);
    wsUrl.searchParams.set('voice', this.userMeta.voice);
    wsUrl.searchParams.set('icon', this.userMeta.icon);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl.toString());
      let connected = false;

      this.ws.onopen = () => {
        connected = true;
        if (this._pingInterval) clearInterval(this._pingInterval);
        this._pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
        resolve();
      };
      this.ws.onerror = (e) => {
        if (!connected) reject(new Error('WebSocket接続に失敗しました（認証エラーまたはネットワークエラー）'));
      };
      this.ws.onmessage = (e) => this._handleSignal(JSON.parse(e.data));
      this.ws.onclose = () => {
        if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
        // 接続確立前のcloseはrejectで処理済みのためdisconnectedを発火しない
        if (connected) this.onEvent({ type: 'disconnected' });
      };
    });
  }

  async _publishLocalTrack() {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
      bundlePolicy: 'max-bundle',
    });

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('[PC] iceConnectionState:', this.peerConnection.iceConnectionState);
      if (this.peerConnection.iceConnectionState === 'failed') {
        this.peerConnection.restartIce();
      }
    };

    // ontrack をここで1回だけ設定（_subscribeToTracks で上書きしない）
    // _pendingTracks キューの先頭と紐付けてリモート音声を接続する
    this.peerConnection.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) {
        console.warn('[ontrack] e.streams[0] is undefined, using track stream');
        return;
      }
      const pending = this._pendingTracks.shift();
      const peerSessId = pending ? pending.peerSessionId : stream.id;
      console.log('[ontrack] attaching audio for peerSessId:', peerSessId);
      this._attachRemoteAudio(peerSessId, stream);
      pending?.resolve?.();
    };

    // ローカル音声トラック追加
    for (const track of this.localStream.getAudioTracks()) {
      this.peerConnection.addTrack(track, this.localStream);
    }

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    // SDP の mid を取得
    const transceivers = this.peerConnection.getTransceivers();
    const tracks = transceivers.map(t => ({
      location: 'local',
      mid: t.mid,
      trackName: 'audio',
    }));

    const result = await this._apiCall(`/api/sessions/${this.sessionId}/tracks`, 'POST', {
      tracks,
      sessionDescription: { type: offer.type, sdp: offer.sdp },
    });

    console.log('[publishLocalTrack] API result:', JSON.stringify(result));

    // iOS WebKit は new RTCSessionDescription() でラップしないと
    // "RTCSessionDescriptionInit.type is required and must be an instance of RTCSdpType" エラーが出る
    if (!result?.sessionDescription?.type) {
      throw new Error(
        `Cloudflare API からセッションDescriptionが取得できませんでした: ${JSON.stringify(result)}`
      );
    }
    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(result.sessionDescription)
    );

    if (result.requiresImmediateRenegotiation) {
      await this._renegotiate();
    }

    // パブリッシュ完了をシグナリングサーバーに通知
    this._send({
      type: 'publish_tracks',
      sessionId: this.sessionId,
      trackNames: tracks.map(t => t.trackName),
    });

    // 話し中検出
    this._startSpeakingDetection();
  }

  // 購読リクエストをキューに追加してシリアル実行する
  // WebRTC はオファー/アンサー交換を同時に複数実行できないため必須
  _subscribeToTracks(peerSessionId, trackNames) {
    return new Promise((outerResolve) => {
      const task = async () => {
        await this._doSubscribe(peerSessionId, trackNames);
        outerResolve();
        // 次のタスクを実行
        if (this._taskQueue.length > 0) {
          const next = this._taskQueue.shift();
          next();
        } else {
          this._subscribeRunning = false;
        }
      };

      if (!this._subscribeRunning) {
        this._subscribeRunning = true;
        task();
      } else {
        this._taskQueue.push(task);
      }
    });
  }

  async _doSubscribe(peerSessionId, trackNames) {
    try {
      const tracks = trackNames.map(trackName => ({
        location: 'remote',
        sessionId: peerSessionId,
        trackName,
      }));

      const result = await this._apiCall(`/api/sessions/${this.sessionId}/tracks`, 'POST', { tracks });
      console.log('[subscribeToTracks] API result for', peerSessionId, ':', JSON.stringify(result));

      if (result.requiresImmediateRenegotiation) {
        if (!result.sessionDescription?.type) {
          throw new Error(`subscribe: sessionDescription なし: ${JSON.stringify(result)}`);
        }

        // ontrack 発火を待つ Promise を先にキューへ追加してから SDP 交換する
        const trackPromise = new Promise(resolve => {
          this._pendingTracks.push({ peerSessionId, resolve });
        });

        // iOS WebKit: new RTCSessionDescription() でラップ必須
        await this.peerConnection.setRemoteDescription(
          new RTCSessionDescription(result.sessionDescription)
        );
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        await this._apiCall(`/api/sessions/${this.sessionId}/renegotiate`, 'PUT', {
          sessionDescription: { type: answer.type, sdp: answer.sdp },
        });

        // ontrack 発火を最大 10 秒待つ
        await Promise.race([
          trackPromise,
          new Promise(res => setTimeout(res, 10000)),
        ]);
      }
    } catch (err) {
      console.error('[_doSubscribe] error for', peerSessionId, ':', err);
    }
  }

  _attachRemoteAudio(peerId, stream) {
    // 既存の audio 要素があれば差し替え
    const existing = this.audioElements.get(peerId);
    if (existing) { existing.pause(); existing.remove(); }

    const audio = document.createElement('audio');
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.playsInline = true;
    document.body.appendChild(audio);
    // iOS は dynamically created audio の autoplay を無視するため明示的に play()
    audio.play().catch(e => console.warn('[remote audio] play() failed:', e));
    this.audioElements.set(peerId, audio);
    this.onEvent({ type: 'remote_audio_attached', peerId });
  }

  _startSpeakingDetection() {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(this.localStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;

    const check = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const isSpeaking = avg > 15;
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        this._send({ type: 'speaking', value: speaking });
        this.onEvent({ type: 'self_speaking', value: speaking });
      }
      this.speakingDetector = requestAnimationFrame(check);
    };
    check();
  }

  async _renegotiate() {
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    const result = await this._apiCall(`/api/sessions/${this.sessionId}/renegotiate`, 'PUT', {
      sessionDescription: { type: offer.type, sdp: offer.sdp },
    });
    if (result?.sessionDescription?.type) {
      await this.peerConnection.setRemoteDescription(
        new RTCSessionDescription(result.sessionDescription)
      );
    }
  }

  _handleSignal(data) {
    switch (data.type) {
      case 'init':
        this.userMeta.clientId = data.clientId;
        data.participants.forEach(p => {
          if (p.clientId !== data.clientId) {
            this.peers.set(p.clientId, p);
          }
        });
        this.onEvent({ type: 'init', participants: data.participants, memos: data.memos });

        // 既存参加者のトラックを購読（シリアルキューで順番に処理）
        data.participants.forEach(p => {
          if (p.clientId !== data.clientId && p.sessionId) {
            this._subscribeToTracks(p.sessionId, p.trackNames);
          }
        });
        break;

      case 'peer_joined':
        this.peers.set(data.participant.clientId, data.participant);
        this.onEvent({ type: 'peer_joined', participant: data.participant });
        break;

      case 'peer_left': {
        // audioElements は peerSessionId (Cloudflare session ID) でキー管理しているため
        // clientId→sessionId の逆引きをしてから audio 要素を削除する
        const leavingPeer = this.peers.get(data.clientId);
        if (leavingPeer?.sessionId) {
          const audioEl = this.audioElements.get(leavingPeer.sessionId);
          if (audioEl) { audioEl.pause(); audioEl.remove(); }
          this.audioElements.delete(leavingPeer.sessionId);
        }
        this.peers.delete(data.clientId);
        this.onEvent({ type: 'peer_left', clientId: data.clientId });
        break;
      }

      case 'peer_tracks':
        if (this.peers.has(data.clientId)) {
          const peer = this.peers.get(data.clientId);
          peer.sessionId = data.sessionId;
          peer.trackNames = data.trackNames;
        }
        this._subscribeToTracks(data.sessionId, data.trackNames);
        break;

      case 'peer_speaking':
        this.onEvent({ type: 'peer_speaking', clientId: data.clientId, value: data.value });
        break;

      case 'pong':
        // ping に対するサーバーからの応答（接続確認用）
        break;

      case 'peer_voice_changed':
        if (this.peers.has(data.clientId)) {
          this.peers.get(data.clientId).voice = data.voice;
        }
        this.onEvent({ type: 'peer_voice_changed', clientId: data.clientId, voice: data.voice });
        break;

      case 'memo':
        this.onEvent({ type: 'memo', memo: data });
        break;
    }
  }

  sendMemo(text) {
    this._send({ type: 'memo', text });
  }

  changeVoice(voice) {
    this._send({ type: 'voice_change', voice });
  }

  setMute(muted) {
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }

  _send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  async _apiCall(path, method, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${WORKER_URL}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  destroy() {
    if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
    if (this.speakingDetector) cancelAnimationFrame(this.speakingDetector);
    this.audioElements.forEach(el => { el.pause(); el.remove(); });
    this.peerConnection?.close();
    this.ws?.close();
  }
}
