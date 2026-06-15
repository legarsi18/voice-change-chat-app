# 軍議の間 — 開発進捗・引き継ぎドキュメント

最終更新: 2026-06-16

---

## アプリ概要

| 項目 | 内容 |
|---|---|
| 名前 | 軍議の間 |
| フロントエンド URL | https://voice-change-chat-app.pages.dev |
| Worker URL | https://voice-chat-worker.legarsi-18k.workers.dev |
| Cloudflare アカウント | legarsi.18k@gmail.com |
| GitHub | https://github.com/legarsi18/voice-change-chat-app |
| スタック | Cloudflare Pages + Workers + Durable Objects + KV + Calls (WebRTC SFU) |
| フロント | Vanilla JS (ES Modules) / Web Audio API + AudioWorklet / WebRTC |

---

## インフラ構成

| サービス | 役割 | 無料枠 |
|---|---|---|
| Cloudflare Pages | フロントエンド静的配信 | 無制限 |
| Cloudflare Workers | API・トークン検証・CF Callsプロキシ | 10万req/日 |
| Cloudflare Durable Objects | WebSocketシグナリング・参加者管理・メモ永続化 | 余裕あり |
| Cloudflare KV | ルーム・トークン保存・レート制限カウンタ | 余裕あり |
| Cloudflare Calls (Realtime SFU) | WebRTC音声中継 | 1,000GB/月 |

---

## ファイル構成

```
voice-change-chat-app/
├── PROGRESS.md              ← このファイル（引き継ぎ）
├── worker/
│   ├── wrangler.toml        ← KV ID / DO 設定
│   └── src/
│       ├── index.js         ← API routes（認証・CF Callsプロキシ）
│       └── room-do.js       ← Durable Object（WS管理・参加者リスト・メモ）
└── public/
    ├── index.html           ← PWA対応（keepalive audio要素あり）
    ├── manifest.json / sw.js
    ├── silence.mp3          ← iOSバックグラウンド用無音
    ├── icons/               ← SVGアイコン8種
    ├── css/style.css
    └── js/
        ├── app.js           ← ルーティング・UI全体・ルームイベントハンドラ
        ├── room.js          ← RoomClient（WebRTC + WS管理）
        ├── voice-changer.js ← VoiceChanger（AudioWorklet pitch-shifter）
        └── worklets/
            └── pitch-shifter.js  ← AudioWorkletProcessor（要 sampleRate:48000）
```

---

## デプロイ手順

```bash
# Worker デプロイ
npx wrangler deploy --config worker/wrangler.toml

# Pages デプロイ
npx wrangler pages deploy public --project-name voice-change-chat-app
```

---

## 技術的な重要ポイント（変更時は必ず確認）

### ⚠️ 絶対に変えてはいけないこと

1. **`sampleRate: 48000`** を VoiceChanger の AudioContext から外さないこと
   → pitch-shifter.js が 48kHz 前提。外すと「ルーム接続エラー」が発生する

2. **sessions エンドポイントに auth を追加しないこと**
   → KV 結合性バグ（別エッジノードへの伝播遅延最大60秒）で再発する
   → sessionId は CF が発行する推測不能 UUID なので auth 不要

3. **`_doSubscribe` の try-catch を戻さないこと**
   → エラーが握り潰されて subscribe 失敗が無音で通過してしまう

4. **iOS テストは必ず Safari で行うこと**
   → Brave は WebRTC/WS 制限あり（参加不可）

5. **publish retry で rollback を使わないこと（PCを閉じて新規作成する）**
   → iOS Safari は `setLocalDescription({type:'rollback'})` の動作が不安定
   → `_closePeerConnection()` + `_setupPeerConnection()` で新規 PC を作るのが正解
   → ※ `_doIceRestart()` の catch での rollback は例外（PC を閉じると全サブスクリプションが消えるため）

### 認証フロー

```
/api/rooms (POST)              ← パスワード認証 → roomId + token (KV TTL 7日)
/api/rooms/:id/lobby?t=TOKEN   ← ロビー画面（tokenをlocalStorageへ保存）
/api/rooms/:id/join (POST)     ← token検証 → CF Callsセッション作成 → sessionId返却
/api/rooms/:id/ws?token=TOKEN  ← WS接続 → DO管理
/api/sessions/:id/tracks (POST)      ← 認証なし（CF Callsへプロキシ）
/api/sessions/:id/renegotiate (PUT)  ← 認証なし（CF Callsへプロキシ）
```

### WebRTC 音声フロー

```
マイク (getUserMedia + AEC適用済み)
  → VoiceChanger
      AudioContext(48kHz) → AudioWorklet(pitch-shifter) → compressor
      → analyserNode（speaking検出タップ）
      → MediaStreamDestination.stream
  → RTCPeerConnection.addTrack()
  → CF Calls SFU
  → 相手の ontrack → <audio> 再生
```

### CF Calls SDP シーケンス（publish）

```
createOffer() → setLocalDescription(offer) → have-local-offer
→ POST /sessions/:id/tracks  (offer + tracks情報)
→ CF returns answer + requiresImmediateRenegotiation
→ setRemoteDescription(answer) → stable
→ if requiresImmediateRenegotiation: _renegotiate()
```

### CF Calls SDP シーケンス（subscribe）

```
POST /sessions/:id/tracks (remote trackInfo)
→ CF returns offer + requiresImmediateRenegotiation=true
→ setRemoteDescription(CF offer) → have-remote-offer
→ createAnswer() → setLocalDescription(answer) → stable
→ PUT /sessions/:id/renegotiate (answer)
→ ontrack 発火 → <audio> 再生
```

### KV Eventual Consistency 対策

- join 時に token を KV に再書き込み（同エッジノードのキャッシュを確実に更新）
- sessions エンドポイントは auth 不要に変更（根本解決）

### SDP 操作の直列化

`room.js` の SDP 操作は `_subscribeRunning` / `_iceRestarting` の2フラグで完全に直列化されている。

```
connect() 中:         _subscribeRunning = true  → subscribe タスクはキューへ
publish 完了後:       _subscribeRunning = false → キュードレイン
ICEリスタート開始:    _iceRestarting = true     → 新規 subscribe もキューへ
ICEリスタート完了:    finally で _iceRestarting = false → キュードレイン
```

---

## 実装済み機能

- [x] ホーム画面（管理者パスワード付きルーム作成 + 招待URL発行）
- [x] ロビー画面（アイコン・名前・ボイス設定）
- [x] STEP1〜3 段階マイクテスト（ビープ→生マイク→ボイスチェンジ）
- [x] ボイスチェンジャー 11種（素の声 + VOICEVOXキャラクター 10種）
- [x] ボイス調整パネル（8パラメータスライダー / localStorageカスタム保存）
- [x] テスト再生ボタン（リアルタイムプレビュー）
- [x] 通話画面（参加者カード・話し中リング・タイマー）
- [x] 共有メモ機能
- [x] 通話中ボイス切り替え・ミュートボタン
- [x] 退出後画面（#/left/:roomId / 再参加ボタン / 期限切れメッセージ）
- [x] PWA対応（ホーム画面追加 / Service Worker）
- [x] iOSバックグラウンド音声維持（silence.mp3 keepalive）
- [x] WebSocket keepalive ping（25秒間隔）
- [x] 戦国テーマSVGアイコン8種 + カスタム画像アップロード

---

## ボイスチェンジャー設計（v18）

### アルゴリズム
- **位相ロック Phase Vocoder**（N=4096, Ha=256, 16xオーバーラップ）
- **フォルマントシフト**（pitch と formant を独立制御）
- **EQ**: HP + LowShelf + Peaking×2 + HighShelf + DynamicsCompressor
- **素の声（none）**: FFT 完全スキップ（レイテンシーゼロ）

### 安全パラメータ範囲

```
pitchRatio  : 0.84〜1.19（±3半音。超えると詐欺音声化）
formantRatio: 0.90〜1.18（0.90未満=篭り激増 / 1.20超=詐欺音声化）
breathMix   : 0（全廃。PVノイズに加算されて悪化するため）
```

### プリセット一覧

| キー | ラベル | pitch | formant |
|---|---|---|---|
| none | 素の声 | 1.0 | 1.0 |
| rito | 離途 ♂ | 0.944 | 0.95 |
| saehaku | 黒沢冴白 ♂ | 0.891 | 0.92 |
| kotaro | 白上虎太郎 ♂ | 1.059 | 1.08 |
| takehiro | 玄野武宏 ♂ | 1.026 | 1.00 |
| ryusei | 青山龍星 ♂ | 0.841 | 0.90 |
| bii | 猫使ビィ ♀ | 1.189 | 1.18 |
| tsurugi | 中部つるぎ ♀ | 1.059 | 1.10 |
| zunko | 東北ずん子 ♀ | 1.122 | 1.12 |
| mitama | 暁記ミタマ ♀ | 1.122 | 1.12 |
| tsumugi | 春日部つむぎ ♀ | 1.189 | 1.18 |

---

## 修正履歴

### 過去セッション（〜2026-06-15）

| 修正 | 内容 |
|---|---|
| セキュリティ強化 | CORS制限 / WS token認証 / ルーム作成レート制限 |
| 参加リダイレクトループ修正 | `!sessionData.token` → `!sessionData` チェックに変更 |
| 退出後画面新設 | `#/left/:roomId` / 再参加ボタン / 期限切れメッセージ |
| 音声遅延対策 | `voiceChanger.destroy()` を async 化（AudioContext.close() を await） |
| 音声無音バグ修正 | sessions認証削除 / `_doSubscribe` try-catch削除 / subscribe_errorトースト追加 |
| 非対称音声バグ修正 | iOS AudioContext競合解消（analyserNode共有）/ cfFetchエラー502返却 / requiresImmediateRenegotiation=false throw |

### 今セッション続き2（2026-06-16）— SW キャッシュ・ゴースト音声・`#/`リダイレクトの根本解決

#### 根本原因（3層構造）

**症状**: B が参加できたが一瞬で管理者画面（`#/`）へ遷移、A の声が管理者画面で聞こえる、B は A の画面に表示されない

1. **SW（Service Worker）が旧 app.js をキャッシュ** (`sakusen-v26`)
   - 旧コードでは `connect()` エラー時に `location.hash = '#/'`（管理者画面）へ遷移
   - 旧コードでは `roomClient.destroy()` がエラーハンドラーで呼ばれないため、音声要素（`<audio>` in body）が残留
   - B の「管理者画面で A の声が聞こえる」は、**前回テスト**で生成した孤立音声要素の残留

2. **`renderHome/renderLobby/renderLeft` にroomClientクリーンアップがない**
   - ブラウザの戻るボタンでルーム画面から離れた場合、roomClient（WS + WebRTC）が生きたまま残る
   - subscribe が完了すると音声要素が document.body に追加され続ける

3. **`_attachRemoteAudio` が `destroy()` 後にも音声要素を生成する**
   - `connect()` エラー後の `destroy()` 完了前に `ontrack` が発火した場合、孤立音声要素が生まれる

**修正**:
- `sw.js`: CACHE バージョンを `sakusen-v27` に更新 → B のブラウザが新鮮なコードを取得
- `app.js`: `_leaveRoomCleanup()` 関数を追加し、`renderHome/renderLobby/renderLeft` の先頭で呼出す
- `room.js`: `_attachRemoteAudio` で `peerConnection` が null（destroyed後）なら生成スキップ
- `room.js`: WS `onclose`/`onerror` に詳細ログ追加
- `room.js`: `publish_tracks` 送信時に WS 状態をログ出力（WS が閉じている場合に A へ届かない原因を可視化）

### 今セッション続き（2026-06-16）— CF セッション stale 問題の根本解決

#### 8. B が参加できない根本原因（CFセッションの stale 問題）

**原因**:
- lobby の「参加」ボタンで POST /join → CF session X → localStorage に保存 → ルーム画面遷移
- ルーム画面は localStorage の session X を使用して接続を試みる
- **但し**: iOS のページリロードや前回の接続失敗（10分以内）で同じ session X を再利用してしまう
- CF session X がすでに「offer を送ったが answer がない」状態で固着 → 406 `invalid_session_description`
- 既存のリトライ（`_refreshCFSession()`）でもなぜか解決しないケースがあった

**根本修正** (`app.js`):
- `renderLobby()` の参加ボタンから POST `/join` の呼び出しを削除（sessionId を localStorage に保存しない）
- `renderRoom()` で毎回 POST `/join` して新鮮な CF sessionId を取得してから RoomClient を生成
- → stale session を使う可能性が構造的にゼロになる

**副次修正** (`room.js`):
- `_refreshCFSession()` が失敗した際の catch を追加（元のエラーを投げる）

---

### 今セッション（2026-06-16）— room.js / app.js 大規模修正

#### 1. B が参加できない問題（406 / 410 エラー）

**原因**: localStorage に古い CF sessionId が残っており、再接続時に CF が `invalid_session_description`（406）または `session_error`（410）を返す。

**修正** (`room.js`):
- `_publishLocalTrack()` にリトライループを追加
- `_refreshCFSession()`: POST `/api/rooms/:id/join` で新規 CF session 取得
- `_closePeerConnection()` + `_setupPeerConnection()`: ハンドラ null → close → 新 PC 作成
- エラーが `invalid_session_description` / `session_error` を含む場合 1回だけリトライ

#### 2. iOS Safari ICE 自動ロールバック（"wrong state: stable"）

**原因**: `setLocalDescription(offer)` → API await 中に iOS Safari が ICE 収集失敗で signaling state を `stable` に自動ロールバック → `setRemoteDescription(answer)` が "Called in wrong state: stable" で失敗。

**修正** (`room.js`):
- `isStaleSession` の判定条件に `'wrong state'` を追加
- → 新規 CF session + 新規 PC でリトライ → 回復

#### 3. ICE restart の完全実装

**原因**: 元の実装は `restartIce()` のみで CF に SDP が伝わっていなかった。

**修正** (`room.js`):
- `_doIceRestart()`: `createOffer({iceRestart:true})` → `setLocalDescription` → PUT `/renegotiate` → `setRemoteDescription`
- ICE restart 中の subscribe 競合防止: `_iceRestarting` フラグを `_subscribeToTracks()` でもチェック
- `_iceRestarting` を `finally` でリセット（`connected` イベント依存だと固着する）
- finally でキューイングされた subscribe タスクを起動
- catch: `have-local-offer` 固着時に rollback を試みる（iOS Safari では try/catch で保護）

#### 4. ghost session 防止（B のエラー後も A の画面に B が残る）

**原因**: connect エラー時に `roomClient = null` のみで `destroy()` を呼んでいなかった → WS が生き続ける。

**修正** (`app.js`):
- 全 connect エラーパスで `roomClient.destroy()` を呼ぶ
- `roomClient.onEvent = () => {}` → `destroy()` → `roomClient = null` の順序を統一

#### 5. disconnect トーストが遷移先ページに表示される問題

**原因**: `destroy()` が `ws.close()` を呼ぶと `onclose` → `onEvent('disconnected')` → 新ページにトーストが出る。

**修正** (`app.js`):
- 全 `destroy()` 呼び出し前に必ず `roomClient.onEvent = () => {}` を設定
- 対象: connect エラー / leaveYes / reconnectBtn

#### 6. エラー後に管理者ホーム（`#/`）に遷移する問題

**修正** (`app.js`):
- 全エラーパスで `loadInvite(roomId)` → トークンあり → `#/room/:id/lobby?t=TOKEN`、なし → `#/left/:id`

#### 7. その他の修正

- `_closePeerConnection()` で `_iceRestartTimer` もクリア（古いタイマーが新 PC に発火しないよう）
- `reconnectBtn` で `roomClient = null` / `voiceChanger = null` を追加
- `destroy()` 内の `_iceRestartTimer` クリアを `_closePeerConnection()` と二重にしたが無害

---

## 現在のデプロイ状況

| 項目 | 内容 |
|---|---|
| 最新デプロイ URL | https://95c11a27.voice-change-chat-app.pages.dev |
| デプロイ日時 | 2026-06-16 |
| 修正対象ファイル | `public/js/app.js` |

---

## 🔴 次回セッション最初のタスク（必ずここから始める）

最新デプロイ: https://7a27ba9a.voice-change-chat-app.pages.dev

### テスト結果の受け取りと判断

ユーザーから「今回の修正後のテスト結果」を報告してもらう。

**確認すべき項目:**

| 確認項目 | 期待結果 |
|---|---|
| B がルームに参加できるか | エラーなく参加できる（もしくはリトライで自動回復） |
| A の声が B に聞こえるか | 双方向音声が成立する |
| B の声が A に聞こえるか | 同上 |
| エラー後の遷移先 | `#/room/:id/lobby` または `#/left/:id`（管理者ホームでない） |
| ghost session | エラー後に A の画面から B のカードが消える |
| disconnect トースト | 遷移先ページに出ない |

**問題が残っていた場合のデバッグ手順:**

```
B参加時に「ルーム接続エラー」が出る場合:
  → エラーメッセージの全文を確認
  → "wrong state" / "invalid_session_description" / "session_error" 以外のメッセージ
     → isStaleSession 条件にさらに追加が必要

音声が届かない場合:
  → Safari コンソールで以下を確認
     [AudioStats] bytesSent=0  → VoiceChanger が無音送信
     [AudioStats] audioLevel=0 → VoiceChanger 出力が無音
     subscribe_error トースト   → CF subscribe 失敗
     [PC] connectionState: connected が出ているか

B 参加後に A の画面に B が残る場合:
  → ghost session が再発
  → destroy() が呼ばれているか確認
```

**問題なければ:**
バックログに着手する（下記参照）。

---

## バックログ（優先度低）

| # | 内容 | 備考 |
|---|---|---|
| Bug A | ルーム作成画面クリックで音楽が止まる（silence.mp3 keepalive） | |
| Bug B | テスト再生でマイク許可が毎回出る | |
| 改善 | token TTL の見直し（現在7日 / 24時間に短縮検討） | ユーザー判断待ち |

---

## 既知の仕様上の限界（修正不要）

| 項目 | 内容 |
|---|---|
| iOS Bluetooth イヤホン | getUserMedia で A2DP→HFP 切り替わりスピーカー化。Web API から制御不可。有線推奨 |
| ICE failed during subscribe | subscribe 実行中に ICE が failed になるとリスタートがスキップ。極めて稀。ユーザーは再接続で回復 |
| stale sessionId が毎回 retry を誘発 | localStorage の古い sessionId → 毎起動で retry。透過的で1秒未満のため許容 |
