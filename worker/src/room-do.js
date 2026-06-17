// Durable Object: ルームごとに1インスタンス。WebSocketシグナリングと共有メモを管理。
//
// 【Hibernation対策】
// Cloudflare DOはメッセージが来ない期間にスリープし、コンストラクタが再実行される。
// this.sessions (Map) はメモリ上のため消える。
// → acceptWebSocket のタグにメタ情報を保存し、起動時に再構築する。
// → メモは DO storage に永続化して消えないようにする。

export class RoomDurableObject {
  constructor(state) {
    this.state = state;
    this.sessions = new Map(); // clientId → { ws, meta }  ※Hibernation後は空になる
    this.memos = [];
    this._memosLoaded = false;
  }

  // Hibernation後の復帰：WebSocketタグからセッションを再構築する
  // sessionId は publish_tracks 受信時に DO storage へも保存しているため、
  // タグの初期meta(sessionId:null)より storage の方が最新情報を持っている。
  async _rebuildSessions() {
    for (const ws of this.state.getWebSockets()) {
      const tags = this.state.getTags(ws);
      const clientId = tags[0];
      if (!clientId || this.sessions.has(clientId)) continue;
      const metaJson = tags[1];
      if (!metaJson) continue;
      try {
        const baseMeta = JSON.parse(metaJson);
        // storage に保存された最新 meta（sessionId / trackNames を含む）を優先する
        const storedMeta = await this.state.storage.get(`meta:${clientId}`);
        const meta = storedMeta || baseMeta;
        this.sessions.set(clientId, { ws, meta });
      } catch {}
    }
  }

  async _loadMemos() {
    if (!this._memosLoaded) {
      this.memos = (await this.state.storage.get('memos')) || [];
      this._memosLoaded = true;
    }
  }

  async fetch(request) {
    // 既存セッションを復元してから新規参加者を追加する
    await this._rebuildSessions();
    await this._loadMemos();

    const url = new URL(request.url);
    const [client, server] = Object.values(new WebSocketPair());
    const clientId = crypto.randomUUID();

    const meta = {
      clientId,
      name:  url.searchParams.get('name')  || '参加者',
      voice: url.searchParams.get('voice') || 'none',
      icon:  url.searchParams.get('icon')  || 'male-1',
      sessionId: null,
      trackNames: [],
      speaking: false,
      muted: false,
    };

    // タグにメタ情報を保存（Hibernation後の再構築に使用）
    this.state.acceptWebSocket(server, [clientId, JSON.stringify(meta)]);
    this.sessions.set(clientId, { ws: server, meta });

    // 参加直後：既存メンバー一覧と過去メモを送信
    server.send(JSON.stringify({
      type: 'init',
      clientId,
      participants: this.participantsList(),
      memos: this.memos,
    }));

    // 他メンバーへ参加通知
    this.broadcast(clientId, { type: 'peer_joined', participant: meta });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // Hibernation後でも確実にセッションが存在するよう再構築
    await this._rebuildSessions();

    const [clientId] = this.state.getTags(ws);
    const session = this.sessions.get(clientId);
    if (!session) return;

    let data;
    try { data = JSON.parse(message); } catch { return; }

    switch (data.type) {
      // 音声トラックの公開完了 → 他全員に購読情報を通知
      case 'publish_tracks':
        session.meta.sessionId  = data.sessionId;
        session.meta.trackNames = data.trackNames;
        // Hibernation復帰後も sessionId が失われないよう DO storage に永続化
        await this.state.storage.put(`meta:${clientId}`, session.meta);
        this.broadcast(clientId, {
          type: 'peer_tracks',
          clientId,
          sessionId:  data.sessionId,
          trackNames: data.trackNames,
        });
        break;

      // 共有メモ送信（DO storage に永続化）
      case 'memo': {
        await this._loadMemos();
        const memo = {
          clientId,
          name:      session.meta.name,
          text:      String(data.text || '').slice(0, 200),
          timestamp: Date.now(),
        };
        this.memos.push(memo);
        if (this.memos.length > 50) this.memos.shift();
        await this.state.storage.put('memos', this.memos); // 永続化
        this.broadcastAll({ type: 'memo', ...memo });
        break;
      }

      // ボイス設定変更
      case 'voice_change':
        session.meta.voice = data.voice;
        this.broadcast(clientId, { type: 'peer_voice_changed', clientId, voice: data.voice });
        break;

      // 話し中インジケーター
      case 'speaking':
        session.meta.speaking = data.value;
        this.broadcast(clientId, { type: 'peer_speaking', clientId, value: data.value });
        break;

      // ミュート状態変更（新規参加者の init に含まれるよう meta に保存）
      case 'mute_state':
        session.meta.muted = data.muted;
        this.broadcast(clientId, { type: 'peer_muted', clientId, muted: data.muted });
        break;

      // WebSocket keepalive ping（クライアントが25秒毎に送信）
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  async webSocketClose(ws) {
    // Hibernation後の復帰でもbroadcastが全員に届くよう再構築する
    await this._rebuildSessions();
    const [clientId] = this.state.getTags(ws);
    this.sessions.delete(clientId);
    // 退出時に永続化していた meta を削除する（再入室時は新しい sessionId が使われるため）
    await this.state.storage.delete(`meta:${clientId}`);
    this.broadcast(clientId, { type: 'peer_left', clientId });
  }

  async webSocketError(ws) {
    await this._rebuildSessions();
    const [clientId] = this.state.getTags(ws);
    this.sessions.delete(clientId);
    await this.state.storage.delete(`meta:${clientId}`);
    this.broadcast(clientId, { type: 'peer_left', clientId });
  }

  // 送信者を除く全員にブロードキャスト
  broadcast(excludeId, message) {
    const msg = JSON.stringify(message);
    for (const [id, { ws }] of this.sessions) {
      if (id !== excludeId) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  // 送信者を含む全員にブロードキャスト
  broadcastAll(message) {
    const msg = JSON.stringify(message);
    for (const { ws } of this.sessions.values()) {
      try { ws.send(msg); } catch {}
    }
  }

  participantsList() {
    return [...this.sessions.values()].map(({ meta }) => meta);
  }
}
