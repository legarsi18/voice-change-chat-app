import { VoiceChanger, VOICE_PRESETS } from './voice-changer.js';
import { RoomClient } from './room.js';

const WORKER_URL = ''; // _worker.js が同一オリジンでプロキシするため相対パスで良い
const STORAGE_KEY = 'voice_chat_profile';
const SESSION_KEY = 'voice_chat_session';
const ROOM_MAX_MS = 3 * 60 * 60 * 1000; // 3時間

let profile = loadProfile();
let voiceChanger = null;
let roomClient = null;
let isMuted = false;
let testMicStream = null; // マイクテスト用ストリームをキャッシュ（iOS許可を使い回す）
let sharedMicStream = null; // ロビーで取得したストリームをルームに引き継ぐ

// ───────────────────────────────────────────
// プロフィール永続化
// ───────────────────────────────────────────
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultProfile(); }
  catch { return defaultProfile(); }
}
function defaultProfile() { return { name: '', voice: 'none', icon: 'male-1' }; }
function saveProfile(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }

// セッション情報をlocalStorageで保持（iOSのページリロード対策）
function saveSession(data) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...data, savedAt: Date.now() }));
}
function loadSession(roomId) {
  try {
    const data = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!data) return null;
    if (data.roomId !== roomId) return null;
    if (Date.now() - data.savedAt > 10 * 60 * 1000) return null; // 10分で無効化
    return data;
  } catch { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }

// ───────────────────────────────────────────
// ルーティング
// ───────────────────────────────────────────
function route() {
  const hash = location.hash || '#/';
  const app = document.getElementById('app');

  if (hash === '#/' || hash === '') {
    renderHome(app);
  } else {
    const lobbyMatch = hash.match(/^#\/room\/([^/]+)\/lobby(\?.*)?$/);
    const roomMatch  = hash.match(/^#\/room\/([^/]+)$/);

    if (lobbyMatch) {
      const roomId = lobbyMatch[1];
      const params = new URLSearchParams(lobbyMatch[2]?.slice(1));
      renderLobby(app, roomId, params.get('t'));
    } else if (roomMatch) {
      renderRoom(app, roomMatch[1]);
    } else {
      renderHome(app);
    }
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

// ───────────────────────────────────────────
// ホーム画面（管理者パスワード付きルーム作成）
// ───────────────────────────────────────────
function renderHome(app) {
  app.innerHTML = `
    <div class="screen home-screen">
      <div class="logo">⚔️ 作戦会議</div>
      <p class="subtitle">招待URLを発行してメンバーを招集</p>
      <div class="section">
        <label class="section-label" for="pwInput">管理者パスワード</label>
        <input class="input" id="pwInput" type="password" placeholder="パスワードを入力">
      </div>
      <button class="btn btn-primary" id="createBtn">ルームを作成する</button>
    </div>
  `;

  document.getElementById('createBtn').addEventListener('click', async () => {
    const password = document.getElementById('pwInput').value;
    if (!password) { alert('パスワードを入力してください'); return; }

    const btn = document.getElementById('createBtn');
    btn.disabled = true;
    btn.textContent = '作成中…';

    try {
      const res = await fetch(`${WORKER_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'ルーム作成に失敗しました');
      }
      const { roomId, token } = await res.json();
      const inviteUrl = `${location.origin}${location.pathname}#/room/${roomId}/lobby?t=${token}`;

      app.innerHTML = `
        <div class="screen home-screen">
          <div class="logo">⚔️ 作戦会議</div>
          <div class="invite-box">
            <p class="invite-label">招待URLをメンバーに共有してください</p>
            <div class="invite-url" id="inviteUrl">${inviteUrl}</div>
            <button class="btn btn-secondary" id="copyBtn">コピー</button>
          </div>
          <button class="btn btn-primary" id="joinOwnRoom" data-room="${roomId}" data-token="${token}">
            自分もこのルームに入る
          </button>
        </div>
      `;

      document.getElementById('copyBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(inviteUrl);
        document.getElementById('copyBtn').textContent = 'コピー済み ✓';
      });

      document.getElementById('joinOwnRoom').addEventListener('click', (e) => {
        location.hash = `#/room/${e.target.dataset.room}/lobby?t=${e.target.dataset.token}`;
      });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'ルームを作成する';
      alert(err.message);
    }
  });
}

// ───────────────────────────────────────────
// ロビー画面
// ───────────────────────────────────────────
function renderLobby(app, roomId, token) {
  const iconOptions = ['male-1','male-2','male-3','male-4','female-1','female-2','female-3','female-4'];

  const voiceOptions = Object.entries(VOICE_PRESETS).map(([key, p]) => `
    <label class="voice-option ${profile.voice === key ? 'selected' : ''}">
      <input type="radio" name="voice" value="${key}" ${profile.voice === key ? 'checked' : ''}>
      <span class="voice-label">${p.label}</span>
      <span class="voice-desc">${p.description}</span>
    </label>
  `).join('');

  app.innerHTML = `
    <div class="screen lobby-screen">
      <h2>ルームに参加する</h2>

      <!-- マイク権限ステータス -->
      <div id="micStatus" class="mic-status-bar" style="display:none"></div>

      <section class="section">
        <label class="section-label">アイコン</label>
        <div class="icon-grid">
          ${iconOptions.map(id => `
            <button class="icon-btn ${profile.icon === id ? 'selected' : ''}" data-icon="${id}">
              <img src="/icons/${id}.svg" alt="${id}">
            </button>
          `).join('')}
          <label class="icon-btn upload-btn" title="画像をアップロード">
            <span>📷</span>
            <input type="file" accept="image/*" id="iconUpload" hidden>
          </label>
        </div>
        <div id="uploadPreview" class="upload-preview" style="display:none">
          <img id="uploadedIcon" src="" alt="アップロード画像">
          <button class="btn-small" id="clearUpload">✕</button>
        </div>
      </section>

      <section class="section">
        <label class="section-label" for="nameInput">表示名</label>
        <input class="input" id="nameInput" type="text" placeholder="例：信長" maxlength="16" value="${profile.name}">
      </section>

      <section class="section">
        <label class="section-label">ボイス</label>
        <div class="voice-grid">${voiceOptions}</div>
        <button class="btn btn-secondary btn-small" id="testVoice">🎤 プレビューON（声を確認する）</button>
        <div id="testStatus" class="test-status"></div>
        <audio id="monitorAudio" playsinline style="display:none"></audio>
        <p class="test-note">※ イヤホン推奨。スピーカーだとハウリングします</p>
      </section>

      <button class="btn btn-primary" id="joinBtn">ルームに参加する</button>
    </div>
  `;

  let uploadedIconData = null;

  // アイコン選択
  document.querySelectorAll('.icon-btn[data-icon]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.icon-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      profile.icon = btn.dataset.icon;
      uploadedIconData = null;
      document.getElementById('uploadPreview').style.display = 'none';
    });
  });

  document.getElementById('iconUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    uploadedIconData = await resizeImage(file, 100);
    document.getElementById('uploadedIcon').src = uploadedIconData;
    document.getElementById('uploadPreview').style.display = 'flex';
    document.querySelectorAll('.icon-btn').forEach(b => b.classList.remove('selected'));
    profile.icon = 'custom';
  });

  document.getElementById('clearUpload').addEventListener('click', () => {
    uploadedIconData = null;
    document.getElementById('uploadPreview').style.display = 'none';
    profile.icon = 'male-1';
    document.querySelector('[data-icon="male-1"]')?.classList.add('selected');
  });

  document.querySelectorAll('input[name="voice"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      document.querySelectorAll('.voice-option').forEach(o => o.classList.remove('selected'));
      e.target.closest('.voice-option').classList.add('selected');
      profile.voice = e.target.value;
      // プレビュー中ならリアルタイムでプリセット切り替え
      if (isMonitoring && testVc) {
        testVc.setPreset(profile.voice);
      }
    });
  });

  // マイク権限状態チェック（画面表示直後）
  checkAndShowMicStatus();

  // ライブプレビュートグル（ON/OFFで声をリアルタイム確認）
  let testVc = null;
  let isMonitoring = false;
  const monitorAudio = document.getElementById('monitorAudio');

  async function stopPreview() {
    isMonitoring = false;
    monitorAudio.pause();
    monitorAudio.srcObject = null;
    if (testVc) {
      testVc.setMonitor(false);
      await testVc.audioContext?.close().catch(() => {});
      testVc = null;
    }
    const btn = document.getElementById('testVoice');
    const status = document.getElementById('testStatus');
    if (btn) btn.textContent = '🎤 プレビューON（声を確認する）';
    if (status) status.textContent = '';
  }

  document.getElementById('testVoice').addEventListener('click', async () => {
    const btn = document.getElementById('testVoice');
    const status = document.getElementById('testStatus');

    // ONの場合はOFFにして終了
    if (isMonitoring) {
      await stopPreview();
      return;
    }

    btn.disabled = true;
    status.textContent = 'マイクを起動中…';

    try {
      if (!testMicStream || testMicStream.getTracks().every(t => t.readyState === 'ended')) {
        testMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      showMicStatusBar('ok');

      status.textContent = '音声エンジンを起動中…';
      testVc = new VoiceChanger();
      const outStream = await testVc.init(testMicStream);
      testVc.setPreset(profile.voice);
      await testVc.resume();

      // audio要素でiOS互換再生（audioContext.destinationより確実）
      monitorAudio.srcObject = outStream;
      await monitorAudio.play().catch(() => {
        // audio要素で失敗した場合のフォールバック
        testVc.setMonitor(true);
      });

      isMonitoring = true;
      btn.textContent = '⏹ プレビューOFF（停止）';
      status.textContent = '🔴 プレビュー中… イヤホンでボイスを確認できます。選んだらルームに参加してください。';
    } catch (err) {
      console.error('[testVoice] error:', err);
      testMicStream?.getTracks().forEach(t => t.stop());
      testMicStream = null;
      showMicError(err, status);
    } finally {
      btn.disabled = false;
    }
  });

  // ボイス切替時にプレビュー中ならリアルタイムでプリセット更新

  // 参加ボタン
  document.getElementById('joinBtn').addEventListener('click', async () => {
    const name = document.getElementById('nameInput').value.trim();
    if (!name) { alert('表示名を入力してください'); return; }

    // マイクが確認されていない場合、参加前に取得する
    if (!testMicStream || testMicStream.getTracks().every(t => t.readyState === 'ended')) {
      const status = document.getElementById('testStatus');
      status.textContent = 'マイク確認中…';
      try {
        testMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        showMicStatusBar('ok');
        status.textContent = '';
      } catch (err) {
        showMicError(err, status);
        return; // マイクNGは参加させない
      }
    }

    profile.name = name;
    if (uploadedIconData) profile.iconData = uploadedIconData;
    saveProfile(profile);

    const btn = document.getElementById('joinBtn');
    btn.disabled = true;
    btn.textContent = '接続中…';

    try {
      console.log('[join] roomId:', roomId, 'token:', token);
      if (!token) throw new Error('招待トークンが見つかりません。招待URLを使って開いてください');

      const res = await fetch(`${WORKER_URL}/api/rooms/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      console.log('[join] response:', res.status, data);
      if (!res.ok) throw new Error(data.error || `接続エラー (${res.status})`);
      if (!data.sessionId) throw new Error('セッションIDが取得できませんでした');

      // プレビューを停止してストリームをルームに引き継ぐ
      if (isMonitoring) {
        monitorAudio.pause();
        monitorAudio.srcObject = null;
        testVc?.setMonitor(false);
        await testVc?.audioContext?.close().catch(() => {});
        testVc = null;
        isMonitoring = false;
      }
      sharedMicStream = testMicStream;
      testMicStream = null;

      saveSession({ sessionId: data.sessionId, roomId, token, joinedAt: Date.now() });
      location.hash = `#/room/${roomId}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'ルームに参加する';
      alert(`参加に失敗しました: ${err.message}`);
    }
  });
}

// マイク権限状態を画面上部のバーで表示
async function checkAndShowMicStatus() {
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    if (result.state === 'denied') {
      showMicStatusBar('denied');
    } else if (result.state === 'granted') {
      showMicStatusBar('ok');
    }
    // 'prompt' の場合は何も表示しない（初回）
    result.onchange = () => checkAndShowMicStatus();
  } catch {
    // navigator.permissions 非対応ブラウザは無視
  }
}

function showMicStatusBar(state) {
  const bar = document.getElementById('micStatus');
  if (!bar) return;
  if (state === 'ok') {
    bar.style.cssText = 'display:block;background:#1a3a1a;border:1px solid #4aad5a;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#4aad5a;';
    bar.textContent = '✅ マイク使用可能';
  } else if (state === 'denied') {
    bar.style.cssText = 'display:block;background:#3a1a1a;border:1px solid #c84040;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#ff6060;';
    bar.innerHTML = '🚫 マイクが拒否されています。<br>iOSの場合: <b>設定 → Brave（またはSafari）→ マイク → オン</b><br>Androidの場合: <b>設定 → アプリ → ブラウザ → 権限 → マイク → 許可</b><br>PCの場合: <b>アドレスバーの🔒 → サイトの設定 → マイク → 許可</b><br>変更後にページを再読み込みしてください。';
  }
}

function showMicError(err, statusEl) {
  console.error('[mic] error:', err.name, err.message);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);

  let msg = '';
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    showMicStatusBar('denied');
    if (isIOS) {
      msg = '🚫 マイクが拒否されています\n\n設定 → Brave（またはSafari）→ マイク → オン\n\nその後ページを再読み込みしてください';
    } else if (isAndroid) {
      msg = '🚫 マイクが拒否されています\n\n設定 → アプリ → ブラウザ → 権限 → マイク → 許可\n\nその後ページを再読み込みしてください';
    } else {
      msg = '🚫 マイクが拒否されています\n\nアドレスバーの🔒アイコン → サイトの設定 → マイク → 許可\n\nその後ページを再読み込みしてください';
    }
    if (statusEl) statusEl.textContent = '❌ マイクが拒否されています。上の手順に従って許可してください。';
  } else if (err.name === 'NotFoundError') {
    msg = 'マイクが見つかりません。マイク（イヤホン）が接続されているか確認してください。';
    if (statusEl) statusEl.textContent = '❌ マイクが見つかりません';
  } else {
    msg = `マイクエラー: ${err.message}`;
    if (statusEl) statusEl.textContent = `❌ エラー: ${err.message}`;
  }
  alert(msg);
}

// ───────────────────────────────────────────
// 通話画面
// ───────────────────────────────────────────
async function renderRoom(app, roomId) {
  const sessionData = loadSession(roomId);
  if (!sessionData) {
    alert('招待URLからアクセスしてください');
    clearSession();
    location.hash = '#/';
    return;
  }

  app.innerHTML = `
    <div class="screen room-screen">
      <header class="room-header">
        <span class="room-title">⚔️ 作戦会議</span>
        <span class="participant-count" id="pCount">1人</span>
        <span class="room-timer" id="roomTimer">0:00:00</span>
      </header>

      <div class="participants-grid" id="participants"></div>

      <div class="memo-section">
        <div class="memo-header">📌 作戦メモ</div>
        <div class="memo-list" id="memoList"></div>
        <div class="memo-input-row">
          <input class="input memo-input" id="memoInput" placeholder="決定事項をメモ…" maxlength="200">
          <button class="btn btn-secondary btn-small" id="memoSend">送信</button>
        </div>
      </div>

      <footer class="room-footer">
        <div class="voice-selector">
          <label class="footer-label">声</label>
          <select id="voiceSelect" class="select">
            ${Object.entries(VOICE_PRESETS).map(([k, v]) =>
              `<option value="${k}" ${profile.voice === k ? 'selected' : ''}>${v.label}</option>`
            ).join('')}
          </select>
        </div>
        <button class="btn btn-mute" id="muteBtn">🎤 ミュート</button>
        <button class="btn btn-leave" id="leaveBtn">退出</button>
      </footer>
    </div>
  `;

  const selfIconSrc = profile.icon === 'custom' && profile.iconData
    ? profile.iconData : `/icons/${profile.icon}.svg`;

  addParticipantCard({ clientId: 'self', name: profile.name, voice: profile.voice, iconSrc: selfIconSrc, isSelf: true });

  // 経過時間タイマー
  const joinedAt = sessionData.joinedAt || Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = Date.now() - joinedAt;
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    const el = document.getElementById('roomTimer');
    if (el) el.textContent = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    // 3時間で警告
    if (elapsed >= ROOM_MAX_MS && el) {
      el.style.color = '#c84040';
      el.textContent += ' ⚠️';
      if (elapsed === ROOM_MAX_MS || (elapsed - ROOM_MAX_MS < 1000)) {
        alert('3時間が経過しました。ルームを終了することをおすすめします。');
      }
    }
  }, 1000);

  // ルーム入室時にiOS keepaliveを開始（ホーム画面では発火させない）
  const keepalive = document.getElementById('keepalive');
  if (keepalive?.paused) keepalive.play().catch(() => {});

  // マイク取得（ロビーで既に取得済みの場合は引き継ぐ）
  let micStream = sharedMicStream;
  sharedMicStream = null;
  if (!micStream || micStream.getTracks().every(t => t.readyState === 'ended')) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      clearInterval(timerInterval);
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const hint = isIOS
        ? '\n\niOSの場合: 設定 → ブラウザアプリ → マイク → オン\nその後ページを再読み込みしてください'
        : '\n\nアドレスバーの🔒 → サイトの設定 → マイク → 許可\nその後ページを再読み込みしてください';
      alert(`マイクへのアクセスが拒否されています。${hint}`);
      location.hash = '#/';
      return;
    }
  }

  voiceChanger = new VoiceChanger();
  let processedStream;
  try {
    processedStream = await voiceChanger.init(micStream);
    voiceChanger.setPreset(profile.voice);
    await voiceChanger.resume();
  } catch (err) {
    clearInterval(timerInterval);
    alert(`音声初期化エラー: ${err.message}`);
    location.hash = '#/';
    return;
  }

  roomClient = new RoomClient({
    roomId,
    sessionId: sessionData.sessionId,
    userMeta: { name: profile.name, voice: profile.voice, icon: profile.icon },
    onEvent: handleRoomEvent,
  });

  try {
    await roomClient.connect(processedStream);
  } catch (err) {
    clearInterval(timerInterval);
    alert(`ルーム接続エラー: ${err.message}`);
    voiceChanger.destroy();
    location.hash = '#/';
    return;
  }

  // UIイベント
  document.getElementById('voiceSelect').addEventListener('change', (e) => {
    profile.voice = e.target.value;
    voiceChanger.setPreset(profile.voice);
    saveProfile(profile);
    roomClient.changeVoice(profile.voice);
    updateSelfVoiceLabel(profile.voice);
  });

  document.getElementById('muteBtn').addEventListener('click', () => {
    isMuted = !isMuted;
    roomClient.setMute(isMuted);
    document.getElementById('muteBtn').textContent = isMuted ? '🔇 ミュート解除' : '🎤 ミュート';
    document.getElementById('muteBtn').classList.toggle('muted', isMuted);
  });

  document.getElementById('memoSend').addEventListener('click', sendMemo);
  document.getElementById('memoInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMemo(); });

  document.getElementById('leaveBtn').addEventListener('click', () => {
    // Braveはconfirm()をブロックするためカスタムダイアログを使用
    if (document.getElementById('leaveConfirmOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'leaveConfirmOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:999;';
    overlay.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:28px 24px;width:280px;text-align:center;">
        <p style="font-size:16px;font-weight:700;margin-bottom:8px;">ルームを退出</p>
        <p style="font-size:13px;color:var(--text2);margin-bottom:24px;">退出するとルームから切断されます</p>
        <div style="display:flex;gap:10px;">
          <button id="leaveYes" style="flex:1;padding:12px;background:var(--danger);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">退出する</button>
          <button id="leaveNo" style="flex:1;padding:12px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('leaveYes').addEventListener('click', () => {
      overlay.remove();
      clearInterval(timerInterval);
      clearSession();
      roomClient.destroy();
      voiceChanger?.destroy();
      document.getElementById('keepalive')?.pause();
      location.hash = '#/';
    });
    document.getElementById('leaveNo').addEventListener('click', () => overlay.remove());
  });
}

function sendMemo() {
  const input = document.getElementById('memoInput');
  const text = input.value.trim();
  if (!text) return;
  roomClient.sendMemo(text);
  input.value = '';
}

// ───────────────────────────────────────────
// ルームイベントハンドラー
// ───────────────────────────────────────────
function handleRoomEvent(event) {
  switch (event.type) {
    case 'init':
      event.participants.forEach(p => {
        if (p.clientId !== roomClient.userMeta.clientId)
          addParticipantCard({ ...p, iconSrc: iconSrc(p) });
      });
      event.memos.forEach(m => addMemoItem(m));
      updateParticipantCount();
      break;
    case 'peer_joined':
      addParticipantCard({ ...event.participant, iconSrc: iconSrc(event.participant) });
      updateParticipantCount();
      break;
    case 'peer_left':
      document.getElementById(`card-${event.clientId}`)?.remove();
      updateParticipantCount();
      break;
    case 'peer_speaking':
      document.getElementById(`card-${event.clientId}`)?.classList.toggle('speaking', event.value);
      break;
    case 'self_speaking':
      document.getElementById('card-self')?.classList.toggle('speaking', event.value);
      break;
    case 'memo':
      addMemoItem(event.memo);
      break;
    case 'peer_voice_changed': {
      const label = document.querySelector(`#card-${event.clientId} .card-voice`);
      if (label) label.textContent = VOICE_PRESETS[event.voice]?.label || '';
      break;
    }
  }
}

// ───────────────────────────────────────────
// UI ヘルパー
// ───────────────────────────────────────────
function addParticipantCard({ clientId, name, voice, iconSrc, isSelf = false }) {
  const grid = document.getElementById('participants');
  if (!grid) return;
  const id = isSelf ? 'self' : clientId;
  if (document.getElementById(`card-${id}`)) return;
  const card = document.createElement('div');
  card.className = 'participant-card';
  card.id = `card-${id}`;
  card.innerHTML = `
    <div class="card-icon-wrap">
      <img class="card-icon" src="${iconSrc}" alt="${name}">
      <div class="speaking-ring"></div>
    </div>
    <div class="card-name">${escapeHtml(name)}${isSelf ? ' (自分)' : ''}</div>
    <div class="card-voice">${VOICE_PRESETS[voice]?.label || ''}</div>
  `;
  grid.appendChild(card);
}

function updateSelfVoiceLabel(voice) {
  const label = document.querySelector('#card-self .card-voice');
  if (label) label.textContent = VOICE_PRESETS[voice]?.label || '';
}

function addMemoItem(memo) {
  const list = document.getElementById('memoList');
  if (!list) return;
  const time = new Date(memo.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const item = document.createElement('div');
  item.className = 'memo-item';
  item.innerHTML = `<span class="memo-author">${escapeHtml(memo.name)}</span><span class="memo-text">${escapeHtml(memo.text)}</span><span class="memo-time">${time}</span>`;
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

function updateParticipantCount() {
  const count = document.querySelectorAll('.participant-card').length;
  const el = document.getElementById('pCount');
  if (el) el.textContent = `${count}人`;
}

function iconSrc(peer) {
  return peer.iconData ? peer.iconData : `/icons/${peer.icon || 'male-1'}.svg`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function resizeImage(file, size) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width-s)/2, (img.height-s)/2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = url;
  });
}
