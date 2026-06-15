import { VoiceChanger, VOICE_PRESETS } from './voice-changer.js';
import { RoomClient } from './room.js';

const WORKER_URL = ''; // _worker.js が同一オリジンでプロキシするため相対パスで良い
const STORAGE_KEY = 'voice_chat_profile';
const SESSION_KEY = 'voice_chat_session';
const INVITE_KEY  = 'voice_chat_invite';  // 招待トークン保存（再入室時のロビーへの自動リダイレクト用）
const CUSTOM_PARAMS_KEY = 'voiceCustomParams';
const ROOM_MAX_MS = 3 * 60 * 60 * 1000; // 3時間

let profile = loadProfile();
let voiceChanger = null;
let roomClient = null;
let isMuted = false;
let testMicStream = null; // マイクテスト用ストリームをキャッシュ（iOS許可を使い回す）
let sharedMicStream = null; // ロビーで取得したストリームをルームに引き継ぐ

// ── ボイス調整パネル用 ──
let panelTestVc = null;
let panelTestMicStream = null;
let panelTestingVoice = null;

// 調整可能な8パラメータの定義
const PARAM_DEFS = [
  { key: 'pitchRatio',   label: '声の高低',        min: 0.84,  max: 1.19,  step: 0.001, fmt: v => v.toFixed(3),                           desc: '低くしたい→下げる / 高くしたい→上げる / 機械感が増したら元に戻す' },
  { key: 'formantRatio', label: '声の太細',        min: 0.90,  max: 1.18,  step: 0.001, fmt: v => v.toFixed(3),                           desc: '篭りがひどい→1.0に近づける / キャラ感を出したい→離す（※篭り増加に注意）' },
  { key: 'lsGain',       label: '低音の強さ',      min: -4,    max: 5,     step: 0.1,   fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB', desc: '重くしたい→上げる / 軽くしたい・篭る→下げる' },
  { key: 'pkFreq',       label: '中域EQ 周波数',   min: 200,   max: 4000,  step: 10,    fmt: v => Math.round(v) + ' Hz',                  desc: '篭る帯域を特定してその周波数を設定（人の声の主要域: 300〜3000 Hz）' },
  { key: 'pkGain',       label: '中域EQ 強さ',     min: -6,    max: 6,     step: 0.1,   fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB', desc: '篭りをカット→下げる / 前に出したい→上げる' },
  { key: 'pk2Freq',      label: '中高域EQ 周波数', min: 1000,  max: 8000,  step: 10,    fmt: v => Math.round(v) + ' Hz',                  desc: 'プレゼンス・明るさの調整（主要域: 2000〜6000 Hz）' },
  { key: 'pk2Gain',      label: '中高域EQ 強さ',   min: -6,    max: 6,     step: 0.1,   fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB', desc: '明るくしたい・キャラ感→上げる / 耳障り・ノイズっぽい→下げる' },
  { key: 'hsGain',       label: '高音・空気感',    min: -3,    max: 6,     step: 0.1,   fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB', desc: 'シャリシャリ感・空気感→上げる / ノイズっぽい・機械的→下げる' },
];

// カスタムパラメータ永続化ヘルパー
function loadCustomParams() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PARAMS_KEY)) || {}; } catch { return {}; }
}
function saveCustomParamsForVoice(voiceKey, params) {
  const all = loadCustomParams();
  all[voiceKey] = params;
  localStorage.setItem(CUSTOM_PARAMS_KEY, JSON.stringify(all));
}
function resetCustomParamsForVoice(voiceKey) {
  const all = loadCustomParams();
  delete all[voiceKey];
  localStorage.setItem(CUSTOM_PARAMS_KEY, JSON.stringify(all));
}

async function stopPanelTest() {
  if (panelTestVc) {
    panelTestVc.setMonitor(false);
    await panelTestVc.audioContext?.close().catch(() => {});
    panelTestVc = null;
  }
  if (panelTestingVoice) {
    const btn = document.querySelector(`[data-panel-test="${panelTestingVoice}"]`);
    if (btn) { btn.textContent = '▶ テスト再生'; btn.classList.remove('active'); }
    panelTestingVoice = null;
  }
}

// ───────────────────────────────────────────
// プロフィール永続化
// ───────────────────────────────────────────
function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultProfile();
    // プリセットキーが旧バージョン（busho/hime/ninja/gunshi）の場合は none にフォールバック
    if (!VOICE_PRESETS[p.voice]) p.voice = 'none';
    return p;
  } catch { return defaultProfile(); }
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

// 招待トークンを保存（ロビー訪問時に呼ぶ）→ セッション切れ後の再入室に使う
function saveInvite(roomId, token) {
  localStorage.setItem(INVITE_KEY, JSON.stringify({ roomId, token, savedAt: Date.now() }));
}
// 保存済み招待トークンを取得（7日以内のみ有効）
function loadInvite(roomId) {
  try {
    const d = JSON.parse(localStorage.getItem(INVITE_KEY));
    if (!d || d.roomId !== roomId) return null;
    if (Date.now() - d.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return d.token;
  } catch { return null; }
}

// ───────────────────────────────────────────
// ルーティング
// ───────────────────────────────────────────
function route() {
  stopPanelTest(); // 画面遷移時にパネルテストを停止
  const hash = location.hash || '#/';
  const app = document.getElementById('app');

  if (hash === '#/' || hash === '') {
    renderHome(app);
  } else {
    const lobbyMatch = hash.match(/^#\/room\/([^/]+)\/lobby(\?.*)?$/);
    const roomMatch  = hash.match(/^#\/room\/([^/]+)$/);
    const leftMatch  = hash.match(/^#\/left\/([^/]+)$/);

    if (lobbyMatch) {
      const roomId = lobbyMatch[1];
      const params = new URLSearchParams(lobbyMatch[2]?.slice(1));
      renderLobby(app, roomId, params.get('t'));
    } else if (roomMatch) {
      renderRoom(app, roomMatch[1]);
    } else if (leftMatch) {
      renderLeft(app, leftMatch[1]);
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
function buildVoiceAdjustPanelHTML() {
  const customAll = loadCustomParams();

  const voiceItems = Object.entries(VOICE_PRESETS).map(([key, preset]) => {
    const custom = customAll[key] || {};
    const hasCustom = Object.keys(custom).length > 0;

    const sliders = PARAM_DEFS.map(def => {
      const defaultVal = preset[def.key] ?? 0;
      const currentVal = custom[def.key] ?? defaultVal;
      return `
        <div class="vap-slider-row">
          <div class="vap-slider-header">
            <span class="vap-slider-label">${def.label}</span>
            <span class="vap-slider-val" id="vap-val-${key}-${def.key}">${def.fmt(currentVal)}</span>
          </div>
          <input class="vap-slider" type="range"
            id="vap-${key}-${def.key}"
            data-voice="${key}" data-param="${def.key}"
            min="${def.min}" max="${def.max}" step="${def.step}"
            value="${currentVal}">
          <p class="vap-slider-desc">${def.desc}</p>
        </div>`;
    }).join('');

    return `
      <details class="vap-item" id="vap-panel-${key}">
        <summary class="vap-summary">
          <span class="vap-name">${preset.label}</span>
          <span class="vap-desc-short">${preset.description}</span>
          ${hasCustom ? '<span class="vap-badge">カスタム</span>' : '<span class="vap-badge" style="opacity:0">-</span>'}
        </summary>
        <div class="vap-body">
          ${sliders}
          <div class="vap-buttons">
            <button class="btn btn-secondary btn-small" data-panel-test="${key}">▶ テスト再生</button>
            <button class="btn btn-secondary btn-small" data-panel-save="${key}">💾 保存</button>
            <button class="btn btn-secondary btn-small" data-panel-reset="${key}">↩ デフォルト</button>
          </div>
        </div>
      </details>`;
  }).join('');

  return `
    <details class="vap-panel" id="vapPanel">
      <summary class="vap-panel-toggle">🎛 ボイス調整パネル <span class="vap-toggle-hint">（クリックで開く）</span></summary>
      <div class="vap-panel-body">
        <p class="vap-panel-desc">各キャラクターのパラメータをスライダーで調整できます。保存した値は次回以降も維持されます。</p>
        <div id="vapStatus" class="vap-status"></div>
        ${voiceItems}
      </div>
    </details>`;
}

function setupVoiceAdjustPanel() {
  // スライダー変更
  document.querySelectorAll('.vap-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const { voice, param } = slider.dataset;
      const def = PARAM_DEFS.find(d => d.key === param);
      if (!def) return;
      const val = parseFloat(slider.value);
      const valEl = document.getElementById(`vap-val-${voice}-${param}`);
      if (valEl) valEl.textContent = def.fmt(val);

      // テスト中なら即時反映
      if (panelTestingVoice === voice && panelTestVc) {
        panelTestVc.updateFilterParam(param, val);
      }
    });
  });

  // テスト再生ボタン
  document.querySelectorAll('[data-panel-test]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const voiceKey = btn.dataset.panelTest;

      // すでにこのボイスをテスト中なら停止
      if (panelTestingVoice === voiceKey) {
        await stopPanelTest();
        return;
      }
      // 別のボイスをテスト中なら停止
      await stopPanelTest();

      // iOS オーディオアンロック（同期実行が必須）
      let unlockCtx = null;
      try { unlockCtx = new AudioContext(); unlockCtx.resume(); } catch {}

      btn.textContent = '⏳ 起動中…';
      btn.disabled = true;
      const statusEl = document.getElementById('vapStatus');
      if (statusEl) statusEl.textContent = '';

      try {
        if (!panelTestMicStream || panelTestMicStream.getTracks().every(t => t.readyState === 'ended')) {
          panelTestMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        }

        panelTestVc = new VoiceChanger(unlockCtx);
        unlockCtx = null;
        await panelTestVc.init(panelTestMicStream);

        // 現在のスライダー値でグラフ構築
        const preset = VOICE_PRESETS[voiceKey];
        const merged = { ...preset };
        PARAM_DEFS.forEach(def => {
          const slider = document.getElementById(`vap-${voiceKey}-${def.key}`);
          if (slider) merged[def.key] = parseFloat(slider.value);
        });
        panelTestVc.setParamsDirect(merged);
        panelTestVc.setMonitor(true);

        panelTestingVoice = voiceKey;
        btn.textContent = '⏹ 停止';
        btn.classList.add('active');
        if (statusEl) statusEl.textContent = `🔴 ${preset.label} をテスト再生中… イヤホン推奨`;
      } catch (err) {
        await unlockCtx?.close().catch(() => {});
        btn.textContent = '▶ テスト再生';
        if (statusEl) statusEl.textContent = `❌ エラー: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  });

  // 保存ボタン
  document.querySelectorAll('[data-panel-save]').forEach(btn => {
    btn.addEventListener('click', () => {
      const voiceKey = btn.dataset.panelSave;
      const params = {};
      PARAM_DEFS.forEach(def => {
        const slider = document.getElementById(`vap-${voiceKey}-${def.key}`);
        if (slider) params[def.key] = parseFloat(slider.value);
      });
      saveCustomParamsForVoice(voiceKey, params);

      // バッジ更新
      const details = document.getElementById(`vap-panel-${voiceKey}`);
      const badge = details?.querySelector('.vap-badge');
      if (badge) { badge.textContent = 'カスタム'; badge.style.opacity = '1'; }

      const statusEl = document.getElementById('vapStatus');
      if (statusEl) { statusEl.textContent = `💾 ${VOICE_PRESETS[voiceKey].label} の設定を保存しました`; }
    });
  });

  // デフォルトに戻すボタン
  document.querySelectorAll('[data-panel-reset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const voiceKey = btn.dataset.panelReset;
      resetCustomParamsForVoice(voiceKey);
      const preset = VOICE_PRESETS[voiceKey];

      // スライダーをデフォルト値に戻す
      PARAM_DEFS.forEach(def => {
        const slider = document.getElementById(`vap-${voiceKey}-${def.key}`);
        const valEl  = document.getElementById(`vap-val-${voiceKey}-${def.key}`);
        const defaultVal = preset[def.key] ?? 0;
        if (slider) slider.value = defaultVal;
        if (valEl) valEl.textContent = def.fmt(defaultVal);

        if (panelTestingVoice === voiceKey && panelTestVc) {
          panelTestVc.updateFilterParam(def.key, defaultVal);
        }
      });

      // バッジ非表示
      const details = document.getElementById(`vap-panel-${voiceKey}`);
      const badge = details?.querySelector('.vap-badge');
      if (badge) { badge.textContent = '-'; badge.style.opacity = '0'; }

      const statusEl = document.getElementById('vapStatus');
      if (statusEl) { statusEl.textContent = `↩ ${preset.label} をデフォルト値にリセットしました`; }
    });
  });
}

function renderHome(app) {
  app.innerHTML = `
    <div class="screen home-screen">
      <div class="logo">軍議の間</div>
      <p class="subtitle">招待URLを発行してメンバーを招集</p>
      <div class="home-form">
        <div class="section">
          <label class="section-label" for="pwInput">管理者パスワード</label>
          <input class="input" id="pwInput" type="password" placeholder="パスワードを入力">
        </div>
        <button class="btn btn-primary" id="createBtn">ルームを作成する</button>
      </div>
      ${buildVoiceAdjustPanelHTML()}
    </div>
  `;

  // createBtn を先にバインド（setupVoiceAdjustPanel がエラーでも動くように）
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
          <div class="logo">軍議の間</div>
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

  // パネルのイベントはcreateBtn登録後に設定（エラーが出ても作成ボタンは動く）
  try { setupVoiceAdjustPanel(); } catch (e) { console.error('[VoicePanel]', e); }
}

// ───────────────────────────────────────────
// ロビー画面
// ───────────────────────────────────────────
function renderLobby(app, roomId, token) {
  // 招待トークンを保存しておく → セッション切れで直接ルームURLにアクセスした時に
  // ロビーへ自動リダイレクトできるようにする
  if (token) saveInvite(roomId, token);

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

        <!-- STEP1: AudioContext動作確認（マイク不要・ビープ音） -->
        <button class="btn btn-gold btn-small" id="beepTest" style="margin-bottom:6px;">🔊 STEP1: スピーカーテスト（ビープ音）</button>
        <!-- STEP2: マイク直接確認（AudioWorkletなし） -->
        <button class="btn btn-gold btn-small" id="micDirectTest" style="margin-bottom:6px;">🎙 STEP2: マイク直接確認（加工なし）</button>
        <!-- STEP3: ボイスチェンジプレビュー（AudioWorklet使用） -->
        <button class="btn btn-gold btn-small" id="testVoice">🎤 STEP3: プレビューON（ボイスチェンジ）</button>
        <div id="testStatus" class="test-status"></div>
        <!-- display:none だとiOSがplay()を拒否するため、不可視だが有効な状態にする -->
        <audio id="monitorAudio" playsinline style="position:absolute;width:0;height:0;opacity:0;pointer-events:none"></audio>
        <p class="test-note">※ イヤホン推奨。スピーカーだとハウリングします<br>※ まずSTEP1→2→3の順に試してください<br>※ Bluetoothイヤホンはマイク起動後にスピーカーに切り替わる場合があります（iOS仕様）。有線イヤホン推奨</p>
        <!-- アプリ内デバッグログ（iOSでコンソールが見えない問題の代替） -->
        <div id="debugLog" style="display:none"></div>
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

  // ─── デバッグログ表示ユーティリティ ───
  function dbg(msg) {
    console.log(`[DEBUG] ${msg}`);
  }

  // ─── STEP 1: ビープ音テスト（AudioContext → スピーカー直結、マイク不要）───
  // これが聞こえない → iOS audio session が有効化されていない
  // これが聞こえる  → AudioContext は正常、問題はマイクかAudioWorklet側
  document.getElementById('beepTest').addEventListener('click', async () => {
    const status = document.getElementById('testStatus');
    // SYNC: iOS audio unlock
    const ka = document.getElementById('keepalive');
    if (ka?.paused) ka.play().catch(() => {});

    status.textContent = '🔊 ビープ音を再生中…（3秒）';
    dbg('STEP1 beep start');
    try {
      const ctx = new AudioContext();
      dbg(`ctx.state before resume: ${ctx.state}`);
      await ctx.resume();
      dbg(`ctx.state after resume: ${ctx.state}`);

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.3;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 1.5);
      osc.onended = async () => {
        await ctx.close();
        status.textContent = '✅ STEP1完了。ビープ音は聞こえましたか？ → 聞こえた場合はSTEP2へ';
        dbg('STEP1 done');
      };
    } catch (err) {
      status.textContent = `❌ STEP1失敗: ${err.message}`;
      dbg(`STEP1 error: ${err.name} ${err.message}`, '#f00');
    }
  });

  // ─── STEP 2: マイク直接テスト（AudioWorkletなし、加工なし）───
  // これが聞こえない → マイクの接続かAudioContext.destinationの問題
  // これが聞こえる  → マイクは正常、問題はAudioWorklet（pitch-shifter）側
  let step2Ctx = null;
  document.getElementById('micDirectTest').addEventListener('click', async () => {
    const status = document.getElementById('testStatus');
    const btn = document.getElementById('micDirectTest');

    // すでに実行中なら停止
    if (step2Ctx) {
      await step2Ctx.close().catch(() => {});
      step2Ctx = null;
      btn.textContent = '🎙 STEP2: マイク直接確認（加工なし）';
      status.textContent = '⏹ STEP2停止';
      return;
    }

    // SYNC: iOS audio unlock
    const ka = document.getElementById('keepalive');
    if (ka?.paused) ka.play().catch(() => {});

    btn.disabled = true;
    status.textContent = 'マイク起動中…';
    dbg('STEP2 mic direct test start');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      dbg(`mic acquired: ${stream.getAudioTracks().length} track(s)`);

      const ctx = new AudioContext();
      dbg(`ctx sampleRate: ${ctx.sampleRate}, state: ${ctx.state}`);
      await ctx.resume();
      dbg(`ctx resumed: ${ctx.state}`);

      const src = ctx.createMediaStreamSource(stream);
      src.connect(ctx.destination);
      step2Ctx = ctx;

      // testMicStream も設定しておく（後でJOINに使える）
      testMicStream = stream;
      showMicStatusBar('ok');

      btn.textContent = '⏹ STEP2停止';
      status.textContent = '🔴 STEP2実行中… イヤホンに自分の声が聞こえたらSTEP3へ。聞こえない場合はSTEP1を再確認。';
      dbg('STEP2 running - mic → speaker direct');
    } catch (err) {
      status.textContent = `❌ STEP2失敗: ${err.message}`;
      dbg(`STEP2 error: ${err.name} ${err.message}`, '#f00');
      showMicError(err, status);
    } finally {
      btn.disabled = false;
    }
  });

  // ライブプレビュートグル（ON/OFFで声をリアルタイム確認）
  let testVc = null;
  let isMonitoring = false;
  let previewDirectCtx = null; // VoiceChangerが使えない場合の直接AudioContext
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
    if (previewDirectCtx) {
      await previewDirectCtx.close().catch(() => {});
      previewDirectCtx = null;
    }
    const btn = document.getElementById('testVoice');
    const status = document.getElementById('testStatus');
    if (btn) btn.textContent = '🎤 プレビューON（声を確認する）';
    if (status) status.textContent = '';
  }

  document.getElementById('testVoice').addEventListener('click', async () => {
    const btn = document.getElementById('testVoice');
    const status = document.getElementById('testStatus');

    if (isMonitoring) {
      await stopPreview();
      return;
    }

    // ── iOSオーディオセッションのアンロック（awaitより前に同期実行 ← ここが最重要）──
    // iOS は「ユーザー操作の同期イベント内」で AudioContext を作成し resume() しないと
    // 後から resume() しても音が出ない。また audio.play() も同様。
    const kaEl = document.getElementById('keepalive');
    if (kaEl?.paused) kaEl.play().catch(() => {});
    // AudioContext をここで同期作成して resume() する（awaitなし）
    let iosUnlockCtx = null;
    try {
      iosUnlockCtx = new AudioContext();
      iosUnlockCtx.resume(); // awaitしない。同期で呼ぶことがiOSアンロックの条件
    } catch {}
    // monitorAudio も同期で load() してiOSに「このエレメントは再生する予定」と通知
    monitorAudio.load();

    btn.disabled = true;
    status.textContent = 'マイクを起動中…';

    try {
      // マイクストリームを取得（既取得なら流用）
      if (!testMicStream || testMicStream.getTracks().every(t => t.readyState === 'ended')) {
        testMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      showMicStatusBar('ok');
      dbg(`STEP3: mic ok, tracks=${testMicStream.getAudioTracks().length}`);
      status.textContent = '音声エンジン（AudioWorklet）を起動中…';

      // ── VoiceChanger 起動を試みる ──
      let vcSuccess = false;
      let outStream = null;
      try {
        dbg(`STEP3: iosUnlockCtx state=${iosUnlockCtx?.state}`);
        testVc = new VoiceChanger(iosUnlockCtx);
        iosUnlockCtx = null;
        dbg('STEP3: VoiceChanger created, calling init...');
        outStream = await testVc.init(testMicStream);
        dbg(`STEP3: init done, ctx.state=${testVc.audioContext?.state}, sampleRate=${testVc.audioContext?.sampleRate}`);
        testVc.setPreset(profile.voice);
        await testVc.resume();
        dbg(`STEP3: resume done, ctx.state=${testVc.audioContext?.state}`);
        vcSuccess = true;
      } catch (vcErr) {
        dbg(`STEP3: VoiceChanger FAILED: ${vcErr.name} ${vcErr.message}`, '#f80');
        await testVc?.audioContext?.close().catch(() => {});
        testVc = null;
        outStream = null;
        await iosUnlockCtx?.close().catch(() => {});
        iosUnlockCtx = null;
      }

      if (vcSuccess && outStream) {
        // iOS は audio.srcObject=MediaStreamDestination.stream でplay()がOKを返しても音が出ない
        // → setMonitor(true) で AudioContext.destination に直接つなぐ方式を使う
        // STEP2で confirmed: AudioContext.destination は iOS でも動作する
        testVc.setMonitor(true);
        dbg(`STEP3: setMonitor(true) done, speakerGain=${testVc.speakerGain?.gain?.value}`);
        dbg('STEP3: audio chain: mic→Worklet→compressor→speakerGain→ctx.destination');
        isMonitoring = true;
        btn.textContent = '⏹ STEP3 停止';
        status.textContent = '🔴 プレビュー中（ボイスチェンジ）… イヤホンで声を確認してください。';
      } else {
        // VoiceChanger完全失敗 → 素マイク直接出力（STEP2と同じ）
        dbg('STEP3: VoiceChanger fallback → direct mic', '#f80');
        const ctx = new AudioContext();
        await ctx.resume();
        const src = ctx.createMediaStreamSource(testMicStream);
        src.connect(ctx.destination);
        previewDirectCtx = ctx;
        isMonitoring = true;
        btn.textContent = '⏹ STEP3 停止';
        status.textContent = '🔴 マイク確認中（AudioWorklet失敗のためボイスチェンジなし）… 上のデバッグログを確認してください。';
      }
    } catch (err) {
      dbg(`STEP3 outer error: ${err.name} ${err.message}`, '#f00');
      testMicStream?.getTracks().forEach(t => t.stop());
      testMicStream = null;
      showMicError(err, status);
    } finally {
      btn.disabled = false;
    }
  });

  // ボイス切替時にプレビュー中ならリアルタイムでプリセット更新

  // 参加ボタン
  document.getElementById('joinBtn').addEventListener('click', async (e) => {
    // iOS audio session を参加ボタンクリック時点でアンロック（awaitより前に同期実行）
    // プレビューを使わなかった場合でもルームでの音声を有効化するために必要
    const kaElJoin = document.getElementById('keepalive');
    if (kaElJoin?.paused) kaElJoin.play().catch(() => {});
    try { const ac = new AudioContext(); ac.resume(); setTimeout(() => ac.close(), 500); } catch {}
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
        await previewDirectCtx?.close().catch(() => {});
        previewDirectCtx = null;
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
// 退出完了画面
// ───────────────────────────────────────────
function renderLeft(app, roomId) {
  const savedToken = loadInvite(roomId);
  app.innerHTML = `
    <div class="screen home-screen">
      <div class="logo">軍議の間</div>
      <div class="invite-box" style="text-align:center;padding:24px 20px;">
        <p style="font-size:18px;font-weight:700;margin-bottom:12px;">退出しました</p>
        ${savedToken ? `
          <p style="font-size:14px;color:var(--text2);margin-bottom:20px;">
            再度参加する場合は下のボタンから
          </p>
          <button class="btn btn-primary" id="rejoinBtn">再参加する</button>
        ` : ''}
        <p style="font-size:12px;color:var(--text2);margin-top:${savedToken ? '16px' : '0'};line-height:1.6;">
          ※ 招待リンクの期限が切れている場合は、<br>管理者より新たなURLをご依頼ください
        </p>
      </div>
    </div>
  `;
  if (savedToken) {
    document.getElementById('rejoinBtn').addEventListener('click', () => {
      location.hash = `#/room/${roomId}/lobby?t=${savedToken}`;
    });
  }
}

// ───────────────────────────────────────────
// 通話画面
// ───────────────────────────────────────────
async function renderRoom(app, roomId) {
  const sessionData = loadSession(roomId);
  if (!sessionData) {
    const savedToken = loadInvite(roomId);
    if (savedToken) {
      location.hash = `#/room/${roomId}/lobby?t=${savedToken}`;
      return;
    }
    alert('招待URLからアクセスしてください');
    clearSession();
    location.hash = '#/';
    return;
  }

  app.innerHTML = `
    <div class="screen room-screen">
      <header class="room-header">
        <span class="room-title">軍議の間</span>
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

  // VoiceChanger: ルーム参加時はjoinBtnで既にiOS audio sessionがアンロック済み
  // （joinBtn click → keepalive.play() + new AudioContext().resume() を同期で実行済み）
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
    token: sessionData.token,
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
    document.getElementById('leaveYes').addEventListener('click', async () => {
      overlay.remove();
      clearInterval(timerInterval);
      clearSession();
      roomClient.destroy();
      await voiceChanger?.destroy();
      document.getElementById('keepalive')?.pause();
      location.hash = `#/left/${roomId}`;
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
    case 'subscribe_error': {
      // 音声トラック購読失敗 → ユーザーに通知して再接続を促す
      if (!document.getElementById('subscribeErrorToast')) {
        const t = document.createElement('div');
        t.id = 'subscribeErrorToast';
        t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#8b4000;color:#fff;padding:12px 20px;border-radius:10px;font-size:13px;z-index:999;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.4);max-width:320px;';
        t.innerHTML = '⚠️ 相手の音声を受信できませんでした<br><small>再接続するか、ページを再読み込みしてください</small>';
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 8000);
      }
      break;
    }
    case 'disconnected':
      // WebSocket接続が切断された場合（ネットワーク不安定・アプリバックグラウンド等）
      // 既存のトーストがあれば重複しないようにする
      if (!document.getElementById('disconnectToast')) {
        const toast = document.createElement('div');
        toast.id = 'disconnectToast';
        toast.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#c0392b;color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;z-index:999;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.4);';
        toast.innerHTML = '⚠️ 接続が切れました<br><button id="reconnectBtn" style="margin-top:8px;padding:6px 16px;background:#fff;color:#c0392b;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">再接続する</button>';
        document.body.appendChild(toast);
        document.getElementById('reconnectBtn').addEventListener('click', () => {
          toast.remove();
          // セッション保存済みのトークンを使ってロビーへリダイレクト（再接続フロー）
          const currentHash = location.hash.match(/^#\/room\/([^/]+)/);
          const rid = currentHash?.[1];
          if (rid) {
            const savedToken = loadInvite(rid);
            if (savedToken) {
              roomClient?.destroy();
              voiceChanger?.destroy();
              location.hash = `#/room/${rid}/lobby?t=${savedToken}`;
              return;
            }
          }
          location.reload();
        });
      }
      break;
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
