import { RoomDurableObject } from './room-do.js';

export { RoomDurableObject };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function cfRealtimeUrl(appId, path) {
  return `https://rtc.live.cloudflare.com/v1/apps/${appId}${path}`;
}

async function cfFetch(env, path, method = 'POST', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.CF_APP_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(cfRealtimeUrl(env.CF_APP_ID, path), opts);
  return res.json();
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function validateToken(env, token, roomId) {
  const data = await env.KV.get(`token:${token}`, 'json');
  if (!data) return false;
  if (data.roomId !== roomId) return false;
  if (data.expiresAt < Date.now()) return false;
  return true;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/rooms → ルーム作成
    if (path === '/api/rooms' && request.method === 'POST') {
      const roomId = crypto.randomUUID();
      const token = generateToken();

      await env.KV.put(
        `room:${roomId}`,
        JSON.stringify({ createdAt: Date.now() }),
        { expirationTtl: 60 * 60 * 24 * 30 }
      );
      await env.KV.put(
        `token:${token}`,
        JSON.stringify({ roomId, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
        { expirationTtl: 60 * 60 * 24 * 7 }
      );

      return json({ roomId, token });
    }

    // GET /api/rooms/:roomId/join?t=token → 参加検証 + CFセッション作成
    const joinMatch = path.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (joinMatch && request.method === 'GET') {
      const roomId = joinMatch[1];
      const token = url.searchParams.get('t');

      if (!token || !(await validateToken(env, token, roomId))) {
        return json({ error: '招待リンクが無効か期限切れです' }, 401);
      }

      const session = await cfFetch(env, '/sessions/new');
      return json({ roomId, sessionId: session.sessionId });
    }

    // POST /api/sessions/:sessionId/tracks → トラック公開・購読（CFへのプロキシ）
    const tracksMatch = path.match(/^\/api\/sessions\/([^/]+)\/tracks$/);
    if (tracksMatch && request.method === 'POST') {
      const sessionId = tracksMatch[1];
      const body = await request.json();
      const result = await cfFetch(env, `/sessions/${sessionId}/tracks/new`, 'POST', body);
      return json(result);
    }

    // PUT /api/sessions/:sessionId/renegotiate → 再ネゴシエーション
    const renego = path.match(/^\/api\/sessions\/([^/]+)\/renegotiate$/);
    if (renego && request.method === 'PUT') {
      const sessionId = renego[1];
      const body = await request.json();
      const result = await cfFetch(env, `/sessions/${sessionId}/renegotiate`, 'PUT', body);
      return json(result);
    }

    // WebSocket /api/rooms/:roomId/ws → Durable Object へ
    const wsMatch = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket required', { status: 426 });
      }
      const roomId = wsMatch[1];
      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
