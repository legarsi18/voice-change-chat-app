// WebRTC + Cloudflare Realtime + Durable Objects WebSocket の統合管理

const WORKER_URL = ''; // _worker.js が同一オリジンでプロキシするため相対パスで良い

export class RoomClient {
  constructor({ roomId, sessionId, token, userMeta, onEvent, voiceAnalyser = null }) {
    this.roomId = roomId;
    this.sessionId = sessionId;
    this.token = token;
    this.userMeta = userMeta; // { name, voice, icon, clientId }
    this.onEvent = onEvent;
    this.voiceAnalyser = voiceAnalyser; // VoiceChangerの同一AudioContext内analyser（iOS競合回避）

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
    // ICE disconnected 自動復旧タイマー・実行中フラグ
    this._iceRestartTimer = null;
    this._iceRestarting = false;
  }

  async connect(processedStream) {
    this.localStream = processedStream;

    // publish完了前にsubscribeのSDP交換が割り込まないよう、先にキューをブロック
    this._subscribeRunning = true;

    // 1. Durable Object WebSocket 接続
    await this._connectSignaling();

    // 2. Cloudflare Realtime にローカル音声をパブリッシュ
    await this._publishLocalTrack();

    // publish完了 → subscribeキューを解放
    this._subscribeRunning = false;
    if (this._taskQueue.length > 0) {
      this._subscribeRunning = true;
      const next = this._taskQueue.shift();
      next();
    }
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
        console.error('[WS] onerror fired. connected=', connected, 'readyState=', this.ws?.readyState);
        if (!connected) reject(new Error('WebSocket接続に失敗しました（401認証エラーまたはネットワークエラー）'));
      };
      this.ws.onmessage = (e) => this._handleSignal(JSON.parse(e.data));
      this.ws.onclose = (e) => {
        console.warn('[WS] onclose. code=', e.code, 'reason=', e.reason, 'connected=', connected);
        if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
        // 接続確立前のcloseはrejectで処理済みのためdisconnectedを発火しない
        if (connected) this.onEvent({ type: 'disconnected' });
      };
    });
  }

  // RTCPeerConnection を作成してイベントハンドラとローカルトラックを設定する
  // リトライ時は古いPCをclose()してから再呼び出し
  _setupPeerConnection() {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      bundlePolicy: 'max-bundle',
    });

    this.peerConnection.oniceconnectionstatechange = () => {
      const s = this.peerConnection?.iceConnectionState;
      console.log('[PC] iceConnectionState:', s);
      if (s === 'failed') {
        console.error('[PC] ICE failed → ICE restart');
        this._doIceRestart();
      } else if (s === 'disconnected') {
        // disconnected は一時的な場合があるため10秒待ってから復旧を試みる
        if (this._iceRestartTimer) clearTimeout(this._iceRestartTimer);
        this._iceRestartTimer = setTimeout(() => {
          if (this.peerConnection?.iceConnectionState === 'disconnected') {
            console.warn('[PC] ICE disconnected for 10s → ICE restart');
            this._doIceRestart();
          }
        }, 10000);
      } else if (s === 'connected' || s === 'completed') {
        if (this._iceRestartTimer) { clearTimeout(this._iceRestartTimer); this._iceRestartTimer = null; }
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const s = this.peerConnection?.connectionState;
      console.log('[PC] connectionState:', s);
      if (s === 'connected') {
        // 接続後3秒でaudioSender統計を確認
        setTimeout(() => this._logAudioStats(), 3000);
      }
    };

    // ontrack をここで1回だけ設定（_setupPeerConnection 呼び出しごとにリセット）
    // _pendingTracks キューの先頭と紐付けてリモート音声を接続する
    this.peerConnection.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) {
        console.warn('[ontrack] e.streams[0] is undefined');
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
  }

  async _publishLocalTrack() {
    this._setupPeerConnection();

    // CFセッションが無効な場合（invalid_session_description / session_error）は
    // 新規セッションを取得してPCごと作り直し、1回だけリトライする
    let retried = false;
    while (true) {
      try {
        await this._doPublishSDP();
        break;
      } catch (err) {
        // iOS SafariはICE収集失敗時にシグナリング状態をstableに自動巻き戻しする場合がある
        // → setRemoteDescription(answer)が "wrong state: stable" で失敗する
        // CFセッション側は offer 受信済み・answer 未受信になり次回 406 になるため、
        // 新規セッション+新規PCのリトライで回復できる
        const isStaleSession = err.message?.includes('invalid_session_description') ||
                               err.message?.includes('session_error') ||
                               err.message?.includes('wrong state');
        if (!retried && isStaleSession) {
          retried = true;
          console.warn('[publishLocalTrack] CFセッション無効 → 新規セッション取得してリトライ:', err.message);
          try {
            await this._refreshCFSession();
          } catch (refreshErr) {
            console.error('[publishLocalTrack] セッション更新失敗:', refreshErr.message);
            throw err; // 元のエラーを投げる
          }
          // close前にハンドラをnullにして古いPCのイベントが新PCに影響しないようにする
          this._closePeerConnection();
          this._setupPeerConnection();
          continue;
        }
        throw err;
      }
    }

    // パブリッシュ完了をシグナリングサーバーに通知
    // ws.readyState を明示ログ（OPEN=1 でない場合、A には peer_tracks が届かない）
    console.log('[publishLocalTrack] sending publish_tracks. ws.readyState=', this.ws?.readyState, '(OPEN=1)');
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.error('[publishLocalTrack] ⚠️ WS is NOT open! publish_tracks will be lost → A cannot subscribe to B');
    }
    this._send({
      type: 'publish_tracks',
      sessionId: this.sessionId,
      trackNames: ['audio'],
    });

    // 話し中検出
    this._startSpeakingDetection();
  }

  // ハンドラをnullにしてからPCをclose（古いPCのイベントが新PCに干渉しないよう）
  // タイマーもここでクリアして古いPCへの復旧試行を止める
  _closePeerConnection() {
    if (this._iceRestartTimer) { clearTimeout(this._iceRestartTimer); this._iceRestartTimer = null; }
    if (!this.peerConnection) return;
    this.peerConnection.oniceconnectionstatechange = null;
    this.peerConnection.onconnectionstatechange = null;
    this.peerConnection.ontrack = null;
    this.peerConnection.close();
    this.peerConnection = null;
  }

  // CFセッションを新規作成してthis.sessionIdを更新する
  async _refreshCFSession() {
    const res = await fetch(`${WORKER_URL}/api/rooms/${this.roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token }),
    });
    if (!res.ok) throw new Error(`CFセッション更新失敗: ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (!data.sessionId) throw new Error('新CFセッションIDが取得できませんでした');
    console.log('[refreshCFSession] 新sessionId:', data.sessionId);
    this.sessionId = data.sessionId;
  }

  // SDP offer → CF tracks/new → setRemoteDescription → renegotiate（必要時）
  async _doPublishSDP() {
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

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
  }

  // ICE restart: CFに新しいofferを送り直してICE候補を更新する
  // _subscribeRunning=true（SDP処理中）または既に実行中の場合はスキップ
  // ICEリスタート中は subscribe の SDP 操作と並走しないよう _iceRestarting もチェック
  async _doIceRestart() {
    if (!this.peerConnection || this._subscribeRunning || this._iceRestarting) return;
    this._iceRestarting = true;
    try {
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      const result = await this._apiCall(`/api/sessions/${this.sessionId}/renegotiate`, 'PUT', {
        sessionDescription: { type: offer.type, sdp: offer.sdp },
      });
      if (result?.sessionDescription?.type) {
        await this.peerConnection.setRemoteDescription(
          new RTCSessionDescription(result.sessionDescription)
        );
      }
      console.log('[ICE restart] renegotiation complete');
    } catch (e) {
      console.error('[ICE restart] failed:', e);
      // setLocalDescription後にAPIが失敗するとPCがhave-local-offer状態で固まる
      // → subscribe時にInvalidStateErrorが発生するためrollbackしてstableに戻す
      if (this.peerConnection?.signalingState === 'have-local-offer') {
        try { await this.peerConnection.setLocalDescription({ type: 'rollback' }); } catch {}
      }
    } finally {
      this._iceRestarting = false;
      // ICEリスタート中にキューイングされた subscribe タスクを起動する
      if (this._taskQueue.length > 0 && !this._subscribeRunning) {
        this._subscribeRunning = true;
        const next = this._taskQueue.shift();
        next();
      }
    }
  }

  // 購読リクエストをキューに追加してシリアル実行する
  // WebRTC はオファー/アンサー交換を同時に複数実行できないため必須
  // ICEリスタート中の subscribe も _iceRestarting フラグで直列化する
  _subscribeToTracks(peerSessionId, trackNames) {
    return new Promise((outerResolve) => {
      const task = async () => {
        try {
          await this._doSubscribe(peerSessionId, trackNames);
        } catch (err) {
          console.error('[_subscribeToTracks] 音声トラック購読失敗:', peerSessionId, err);
          this.onEvent({ type: 'subscribe_error', peerSessionId, message: err.message });
        }
        outerResolve();
        // 次のタスクを実行
        if (this._taskQueue.length > 0) {
          const next = this._taskQueue.shift();
          next();
        } else {
          this._subscribeRunning = false;
        }
      };

      if (!this._subscribeRunning && !this._iceRestarting) {
        this._subscribeRunning = true;
        task();
      } else {
        this._taskQueue.push(task);
      }
    });
  }

  async _doSubscribe(peerSessionId, trackNames) {
    const tracks = trackNames.map(trackName => ({
      location: 'remote',
      sessionId: peerSessionId,
      trackName,
    }));

    const result = await this._apiCall(`/api/sessions/${this.sessionId}/tracks`, 'POST', { tracks });
    console.log('[subscribeToTracks] API result for', peerSessionId, ':', JSON.stringify(result));

    // CFがエラーレスポンスを返した場合
    if (result.errorCode || result.error) {
      throw new Error(`CF subscribe エラー [${result.errorCode || result.cfStatus}]: ${result.errorDescription || result.error}`);
    }

    // subscribeは常にrequiresImmediateRenegotiation=trueのはず
    if (!result.requiresImmediateRenegotiation) {
      console.error('[subscribeToTracks] 予期しないレスポンス（requiresImmediateRenegotiation=false）:', JSON.stringify(result));
      throw new Error(`subscribe: 予期せぬCFレスポンス: ${JSON.stringify(result)}`);
    }

    // requiresImmediateRenegotiation=true（上でfalseはthrow済みなので常にここに到達）
    if (!result.sessionDescription?.type) {
      throw new Error(`subscribe: sessionDescription なし: ${JSON.stringify(result)}`);
    }

    const trackPromise = new Promise(resolve => {
      this._pendingTracks.push({ peerSessionId, resolve });
    });

    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(result.sessionDescription)
    );
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    await this._apiCall(`/api/sessions/${this.sessionId}/renegotiate`, 'PUT', {
      sessionDescription: { type: answer.type, sdp: answer.sdp },
    });

    await Promise.race([
      trackPromise,
      new Promise(res => setTimeout(res, 10000)),
    ]);
  }

  _attachRemoteAudio(peerId, stream) {
    // destroy()後（peerConnection=null）は音声要素を生成しない
    // connect()エラー後のdestroy()とontrack発火のレースコンディション対策
    if (!this.peerConnection) {
      console.warn('[attachRemoteAudio] skipped: peerConnection already destroyed for', peerId);
      return;
    }
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
    // voiceAnalyser が渡された場合はVoiceChangerの同一AudioContext内のanalyserを使う
    // → 別AudioContextを作らないことでiOSのAudioContext競合を回避
    let analyser = this.voiceAnalyser;
    let ownCtx = null;

    if (!analyser) {
      // フォールバック: 独自AudioContext（VoiceChangerなし環境向け）
      ownCtx = new AudioContext();
      const source = ownCtx.createMediaStreamSource(this.localStream);
      analyser = ownCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
    }

    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;

    const check = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      // ミュート中は常に非発話扱い（analyserはraw音声を見るため）
      const isSpeaking = avg > 15 && !this._muted;
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        this._send({ type: 'speaking', value: speaking });
        this.onEvent({ type: 'self_speaking', value: speaking });
      }
      this.speakingDetector = requestAnimationFrame(check);
    };
    check();
    this._speakingDetectCtx = ownCtx; // destroy時にclose
  }

  async _logAudioStats() {
    if (!this.peerConnection) return;
    try {
      const stats = await this.peerConnection.getStats();
      stats.forEach(r => {
        if (r.type === 'outbound-rtp' && r.kind === 'audio') {
          console.log('[AudioStats] outbound bytesSent:', r.bytesSent, 'packetsSent:', r.packetsSent);
          if (r.bytesSent === 0) {
            console.error('[AudioStats] ⚠️ bytesSent=0 → 音声が送信されていません');
          }
        }
        if (r.type === 'media-source' && r.kind === 'audio') {
          console.log('[AudioStats] media-source audioLevel:', r.audioLevel);
          if (r.audioLevel === 0 || r.audioLevel === undefined) {
            console.error('[AudioStats] ⚠️ audioLevel=0 → VoiceChangerが無音を出力しています');
          }
        }
      });
    } catch (e) {
      console.warn('[AudioStats] getStats失敗:', e);
    }
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

      case 'peer_muted':
        this.onEvent({ type: 'peer_muted', clientId: data.clientId, muted: data.muted });
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
    this._muted = muted;
    // AudioWorklet 出力（通常フォアグラウンド）のトラックを制御
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    // バックグラウンド中は replaceAudioTrack() で生マイクトラックが送信されているため
    // sender の現トラックも直接制御する（replaceTrack 後は localStream トラックと異なる場合がある）
    const senderTrack = this.peerConnection?.getSenders().find(s => s.track?.kind === 'audio')?.track;
    if (senderTrack) senderTrack.enabled = !muted;
    // ミュート状態を他の参加者に通知（バッジ表示用）
    this._send({ type: 'mute_state', muted });
    // ミュート時は即座に speaking=false を全員に通知してリングを消す
    // （analyserはraw音声を見るためtrack.enabled=falseでも反応し続けるため）
    if (muted) {
      this._send({ type: 'speaking', value: false });
      this.onEvent({ type: 'self_speaking', value: false });
    }
  }

  // バックグラウンド↔フォアグラウンド切り替え時に WebRTC 送信トラックを差し替える
  // RTCRtpSender.replaceTrack() は SDP 再ネゴシエーション不要（iOS 14.5+）
  async replaceAudioTrack(track) {
    const sender = this.peerConnection?.getSenders().find(s => s.track?.kind === 'audio');
    if (!sender) return;
    await sender.replaceTrack(track);
    // ミュート状態を新トラックに即時反映（バックグラウンド中にミュート変更があった場合を含む）
    if (track) track.enabled = !this._muted;
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
    if (this._iceRestartTimer) { clearTimeout(this._iceRestartTimer); this._iceRestartTimer = null; }
    if (this.speakingDetector) cancelAnimationFrame(this.speakingDetector);
    this._speakingDetectCtx?.close().catch(() => {});
    this.audioElements.forEach(el => { el.pause(); el.remove(); });
    this._closePeerConnection();
    this.ws?.close();
  }
}
