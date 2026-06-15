import { RoomDurableObject } from './room-do.js';

export { RoomDurableObject };

const ALLOWED_ORIGINS = [
  'https://voice-change-chat-app.pages.dev',
  'https://voice-chat-worker.legarsi-18k.workers.dev',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...(request ? corsHeaders(request) : {}), 'Content-Type': 'application/json' },
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

// ルーム作成のレート制限: 1IPあたり1分間に5回まで
async function checkRateLimit(env, ip) {
  const key = `ratelimit:${ip}`;
  const count = parseInt(await env.KV.get(key) || '0');
  if (count >= 5) return false;
  await env.KV.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/rooms → ルーム作成（管理者パスワード必須）
    if (path === '/api/rooms' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await checkRateLimit(env, ip))) {
        return json({ error: 'しばらく後に試してください' }, 429, request);
      }

      const body = await request.json().catch(() => ({}));
      if (!env.CREATE_PASSWORD || body.password !== env.CREATE_PASSWORD) {
        return json({ error: 'パスワードが違います' }, 403, request);
      }
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

      return json({ roomId, token }, 200, request);
    }

    // POST /api/rooms/:roomId/join → 参加検証 + CFセッション作成
    const joinMatch = path.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (joinMatch && request.method === 'POST') {
      const roomId = joinMatch[1];
      const body = await request.json().catch(() => ({}));
      const token = body.token;

      if (!token || !(await validateToken(env, token, roomId))) {
        console.error('[join] token validation failed. roomId:', roomId, 'token:', token);
        return json({ error: '招待リンクが無効か期限切れです' }, 401, request);
      }

      const session = await cfFetch(env, '/sessions/new');
      // sessionId を KV に登録しておき、/api/sessions/* の認証に使う
      await env.KV.put(
        `session:${session.sessionId}`,
        JSON.stringify({ roomId }),
        { expirationTtl: 60 * 60 * 24 }
      );
      return json({ roomId, sessionId: session.sessionId }, 200, request);
    }

    // POST /api/sessions/:sessionId/tracks → トラック公開・購読（CFへのプロキシ）
    const tracksMatch = path.match(/^\/api\/sessions\/([^/]+)\/tracks$/);
    if (tracksMatch && request.method === 'POST') {
      const sessionId = tracksMatch[1];
      if (!(await env.KV.get(`session:${sessionId}`))) {
        return json({ error: 'Unauthorized' }, 401, request);
      }
      const body = await request.json();
      const result = await cfFetch(env, `/sessions/${sessionId}/tracks/new`, 'POST', body);
      return json(result, 200, request);
    }

    // PUT /api/sessions/:sessionId/renegotiate → 再ネゴシエーション
    const renego = path.match(/^\/api\/sessions\/([^/]+)\/renegotiate$/);
    if (renego && request.method === 'PUT') {
      const sessionId = renego[1];
      if (!(await env.KV.get(`session:${sessionId}`))) {
        return json({ error: 'Unauthorized' }, 401, request);
      }
      const body = await request.json();
      const result = await cfFetch(env, `/sessions/${sessionId}/renegotiate`, 'PUT', body);
      return json(result, 200, request);
    }

    // WebSocket /api/rooms/:roomId/ws → token 検証後 Durable Object へ
    const wsMatch = path.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket required', { status: 426 });
      }
      const roomId = wsMatch[1];
      const token = url.searchParams.get('token');
      if (!token || !(await validateToken(env, token, roomId))) {
        return new Response('Unauthorized', { status: 401 });
      }
      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
