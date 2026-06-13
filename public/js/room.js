// WebRTC + Cloudflare Realtime + Durable Objects WebSocket の統合管理

const WORKER_URL = '__WORKER_URL__'; // デプロイ時に実際のWorker URLに置き換える

export class RoomClient {
  constructor({ roomId, sessionId, userMeta, onEvent }) {
    this.roomId = roomId;
    this.sessionId = sessionId;
    this.userMeta = userMeta; // { name, voice, icon, clientId }
    this.onEvent = onEvent;

    this.ws = null;
    this.peerConnection = null;
    this.localStream = null;
    this.peers = new Map(); // clientId → metadata
    this.audioElements = new Map(); // clientId → HTMLAudioElement
    this.speakingDetector = null;
  }

  async connect(processedStream) {
    this.localStream = processedStream;

    // 1. Durable Object WebSocket 接続
    await this._connectSignaling();

    // 2. Cloudflare Realtime にローカル音声をパブリッシュ
    await this._publishLocalTrack();
  }

  async _connectSignaling() {
    const wsUrl = new URL(`${WORKER_URL}/api/rooms/${this.roomId}/ws`);
    wsUrl.protocol = wsUrl.protocol.replace('http', 'ws');
    wsUrl.searchParams.set('name', this.userMeta.name);
    wsUrl.searchParams.set('voice', this.userMeta.voice);
    wsUrl.searchParams.set('icon', this.userMeta.icon);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => resolve();
      this.ws.onerror = reject;
      this.ws.onmessage = (e) => this._handleSignal(JSON.parse(e.data));
      this.ws.onclose = () => this.onEvent({ type: 'disconnected' });
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
      if (this.peerConnection.iceConnectionState === 'failed') {
        this.peerConnection.restartIce();
      }
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

    await this.peerConnection.setRemoteDescription(result.sessionDescription);

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

  async _subscribeToTracks(peerSessionId, trackNames) {
    const tracks = trackNames.map(trackName => ({
      location: 'remote',
      sessionId: peerSessionId,
      trackName,
    }));

    const result = await this._apiCall(`/api/sessions/${this.sessionId}/tracks`, 'POST', { tracks });

    if (result.requiresImmediateRenegotiation) {
      // サーバー側からofferが来るので受け取る
      await this.peerConnection.setRemoteDescription(result.sessionDescription);
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      await this._apiCall(`/api/sessions/${this.sessionId}/renegotiate`, 'PUT', {
        sessionDescription: { type: answer.type, sdp: answer.sdp },
      });
    }

    // リモートトラックを受信するとontrackが発火する
    this.peerConnection.ontrack = (e) => {
      this._attachRemoteAudio(peerSessionId, e.streams[0]);
    };
  }

  _attachRemoteAudio(peerId, stream) {
    if (this.audioElements.has(peerId)) {
      this.audioElements.get(peerId).remove();
    }
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.playsInline = true;
    document.body.appendChild(audio);
    this.audioElements.set(peerId, audio);
    this.onEvent({ type: 'remote_audio_attached', peerId });
  }

  _startSpeakingDetection() {
    const analyser = this.localStream.getAudioTracks()[0]
      ? (() => {
          const ctx = new AudioContext();
          const source = ctx.createMediaStreamSource(this.localStream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          return analyser;
        })()
      : null;

    if (!analyser) return;

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
    await this.peerConnection.setRemoteDescription(result.sessionDescription);
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

        // 既存参加者のトラックを購読
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

      case 'peer_left':
        this.peers.delete(data.clientId);
        this.audioElements.get(data.clientId)?.remove();
        this.audioElements.delete(data.clientId);
        this.onEvent({ type: 'peer_left', clientId: data.clientId });
        break;

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
    const res = await fetch(`${WORKER_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  destroy() {
    if (this.speakingDetector) cancelAnimationFrame(this.speakingDetector);
    this.audioElements.forEach(el => el.remove());
    this.peerConnection?.close();
    this.ws?.close();
  }
}
