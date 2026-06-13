// Cloudflare Pages Worker
// /api/* リクエストを voice-chat-worker に転送（同一オリジン化 → Braveブロック回避）
// それ以外は Pages の静的ファイルを配信

const WORKER_ORIGIN = 'https://voice-chat-worker.legarsi-18k.workers.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const targetUrl = WORKER_ORIGIN + url.pathname + url.search;
      return fetch(new Request(targetUrl, request));
    }

    return env.ASSETS.fetch(request);
  },
};
