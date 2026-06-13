// Durable Object: ルームごとに1インスタンス。WebSocketシグナリングと共有メモを管理。
export class RoomDurableObject {
  constructor(state) {
    this.state = state;
    this.sessions = new Map(); // clientId → { ws, meta }
    this.memos = [];           // 共有メモ履歴（最大50件）
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [client, server] = Object.values(new WebSocketPair());
    const clientId = crypto.randomUUID();

    this.state.acceptWebSocket(server, [clientId]);

    const meta = {
      clientId,
      name: url.searchParams.get('name') || '参加者',
      voice: url.searchParams.get('voice') || 'none',
      icon: url.searchParams.get('icon') || 'male-1',
      sessionId: null,
      trackNames: [],
      speaking: false,
    };

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
    const [clientId] = this.state.getTags(ws);
    const session = this.sessions.get(clientId);
    if (!session) return;

    let data;
    try { data = JSON.parse(message); } catch { return; }

    switch (data.type) {
      // 音声トラックの公開完了 → 他全員に購読情報を通知
      case 'publish_tracks':
        session.meta.sessionId = data.sessionId;
        session.meta.trackNames = data.trackNames;
        this.broadcast(clientId, {
          type: 'peer_tracks',
          clientId,
          sessionId: data.sessionId,
          trackNames: data.trackNames,
        });
        break;

      // 共有メモ送信
      case 'memo': {
        const memo = {
          clientId,
          name: session.meta.name,
          text: String(data.text).slice(0, 200),
          timestamp: Date.now(),
        };
        this.memos.push(memo);
        if (this.memos.length > 50) this.memos.shift();
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
    }
  }

  async webSocketClose(ws) {
    const [clientId] = this.state.getTags(ws);
    this.sessions.delete(clientId);
    this.broadcast(clientId, { type: 'peer_left', clientId });
  }

  async webSocketError(ws) {
    const [clientId] = this.state.getTags(ws);
    this.sessions.delete(clientId);
    this.broadcast(clientId, { type: 'peer_left', clientId });
  }

  broadcast(excludeId, message) {
    const msg = JSON.stringify(message);
    for (const [id, { ws }] of this.sessions) {
      if (id !== excludeId) {
        try { ws.send(msg); } catch {}
      }
    }
  }

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
