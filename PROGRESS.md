# 軍議の間 — 開発進捗・引き継ぎドキュメント

最終更新: 2026-06-18

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

## デプロイ手順（必ず commit → push → deploy の順で）

```bash
# 1. コミット
git add <変更ファイル>
git commit -m "fix: ..."

# 2. GitHub プッシュ
git push origin master

# 3. Pages デプロイ
npx wrangler pages deploy public --project-name voice-change-chat-app

# Worker のみ変更した場合
npx wrangler deploy --config worker/wrangler.toml
```

> ⚠️ **コミットなしデプロイ禁止。** wrangler deploy は git と独立して動く。必ず上の順番を守ること。

### 緊急ロールバック

```bash
git revert HEAD --no-edit
git push origin master
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

6. **ルーム画面遷移時（エラー含む）は必ず `location.replace()` を使うこと**
   → `location.hash = ...` だと履歴に残り、バックボタンでルーム画面に戻ってしまう
   → `renderRoom` の全エラー経路・退出経路は `location.replace()` 統一済み

7. **`renderHome / renderLobby / renderLeft` の先頭で `_leaveRoomCleanup()` を呼ぶこと**
   → バックボタンでルーム外へ遷移した際に roomClient / voiceChanger を確実に破棄する
   → 呼ばないと孤立音声要素（`<audio>` in body）が残留し、他画面でも音声が再生され続ける

### 認証フロー

```
/api/rooms (POST)              ← パスワード認証 → roomId + token (KV TTL 7日)
/api/rooms/:id/lobby?t=TOKEN   ← ロビー画面（tokenをlocalStorageへ保存）
/api/rooms/:id/join (POST)     ← token検証 → CF Callsセッション作成 → sessionId返却
                                  ★ ロビーでは呼ばない。renderRoom 冒頭で毎回呼ぶ
/api/rooms/:id/ws?token=TOKEN  ← WS接続 → DO管理
/api/sessions/:id/tracks (POST)      ← 認証なし（CF Callsへプロキシ）
/api/sessions/:id/renegotiate (PUT)  ← 認証なし（CF Callsへプロキシ）
```

### WebRTC 音声フロー

```
マイク (getUserMedia + AEC適用済み)
  → VoiceChanger
      AudioContext(48kHz) → AudioWorklet(pitch-shifter) → compressor
      → analyserNode（speaking検出タップ）★ iOS競合回避のためRoomClientと共有
      → MediaStreamDestination.stream
  → RTCPeerConnection.addTrack()
  → CF Calls SFU
  → 相手の ontrack → <audio> 再生（document.body に追加）
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

### ミュート時のspeaking検出

- `setMute(true)` 時に即座に `speaking: false` を全員へ送信
- `_startSpeakingDetection` の検出ループで `this._muted` フラグをチェックし `isSpeaking = false` に強制
- analyserNode は raw 音声を見るため `track.enabled = false` だけでは止まらない

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
- [x] ミュート中は speaking リング非表示（B案：プライバシー保護）
- [x] ミュート時に🔇バッジをカードに表示（相手にミュート中と伝える）
- [x] 退出後画面（#/left/:roomId / 再参加ボタン / 期限切れメッセージ）
- [x] 退出後バックボタンでルームに戻らない（location.replace による履歴管理）
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

## Git コミット履歴（主要）

| コミット | 内容 |
|---|---|
| `b8bc7ce` | feat: ミュートバッジ表示 + SW キャッシュ更新(v28) ← **最新** |
| `dde3215` | fix: ミュート中のspeaking表示・退出後バックボタン問題を修正 |
| `e5ead74` | fix: SW キャッシュ・ゴースト音声・接続エラー遷移先を根本修正 |
| `54f57ac` | fix: 無音バグ修正 - sessions認証削除・subscribe失敗を可視化 |
| `5f8adf4` | revert: Bluetooth改善の変更をリバート（ルーム接続エラーの原因） |
| `1588ff9` | feat: 退出後に専用画面を表示・AudioContext完全クリーンアップ |

---

## 現在のデプロイ状況

| 項目 | 内容 |
|---|---|
| 最新コミット | `b8bc7ce` |
| 最新プレビューURL | https://358f877e.voice-change-chat-app.pages.dev |
| 本番URL | https://voice-change-chat-app.pages.dev |
| デプロイ日時 | 2026-06-18 |

---

## 🔴 次回セッション最初のタスク（必ずここから始める）

### STEP 1: PROGRESS.md を読む（このファイル）

### STEP 2: テスト結果を受け取る

ユーザーから「最新デプロイ（`f5ead8a6`）でのテスト結果」を報告してもらう。

**今回デプロイした修正（`dde3215`）の確認項目:**

| 確認項目 | 期待結果 |
|---|---|
| ミュート時に相手のアイコンが緑にならないか | ミュートON → 即座にリング消える |
| 退出後にバックボタンでルーム画面が出ないか | 退出画面（#/left）→ back → ロビー画面（ルームはスキップ） |
| ボイスが正しく切れているか（退出後） | 退出後はマイク・音声セッションが完全停止 |
| 前回解消された項目が悪化していないか | 双方向通話・B参加・遷移先エラーなし |

### STEP 3: 結果に応じて対応

**問題なし → バックログへ（下記参照）**

**問題あり → 根本原因調査から始める**

デバッグ用コンソールログ（room.js に仕込み済み）:
```
[WS] onclose. code=... reason=... connected=...  → WS切断原因
[WS] onerror fired. connected=... readyState=... → WS接続失敗
[publishLocalTrack] sending publish_tracks. ws.readyState=1  → 1=OPEN が正常
[PC] iceConnectionState: ...  → ICE 状態
[PC] connectionState: connected → 接続成功
[AudioStats] outbound bytesSent: 0 → 送信無音
[AudioStats] audioLevel: 0 → VoiceChanger無音出力
```

---

## バックログ（未着手・優先度低）

| # | 内容 | 備考 |
|---|---|---|
| Bug A | ルーム作成画面クリックで音楽が止まる（silence.mp3 keepalive） | 軽微 |
| Bug B | テスト再生でマイク許可が毎回出る | 軽微 |
| 改善 | token TTL の見直し（現在7日 / 24時間に短縮検討） | ユーザー判断待ち |

---

## 既知の仕様上の限界（修正不要）

| 項目 | 内容 |
|---|---|
| iOS Bluetooth イヤホン | getUserMedia で A2DP→HFP 切り替わりスピーカー化。Web API から制御不可。有線推奨 |
| ICE failed during subscribe | subscribe 実行中に ICE が failed になるとリスタートがスキップ。極めて稀。ユーザーは再接続で回復 |

---

## 修正履歴（詳細）

### 2026-06-17: ミュート表示・バックボタン修正（`dde3215`）

#### ミュート中 speaking リング問題
- **原因**: analyserNode は raw 音声を見るため `track.enabled = false` だけでは止まらない
- **修正**: `setMute(true)` 時に `speaking: false` を即送信 + 検出ループで `_muted` フラグをチェック

#### 退出後バックボタン問題
- **原因**: `location.hash = '#/left/:id'` は履歴スタックに積まれ、back でルームURLに戻る
- **修正**: 退出・全エラー経路の遷移を `location.replace()` に統一
  - `location.replace` は現在の履歴エントリを置換するため、ルームURLが履歴から消える
  - 退出後 back → ロビー（ルームはスキップ）

### 2026-06-17: SW キャッシュ・ゴースト音声修正（`e5ead74`）

#### SW キャッシュ問題（最大の根本原因）
- **原因**: SW `CACHE = 'sakusen-v26'` が更新されておらず、B のブラウザが旧 app.js を配信
  旧コードでは `connect()` エラー → `location.hash = '#/'`（管理者画面）+ `roomClient.destroy()` 未呼び出し
- **修正**: `sakusen-v27` に更新

#### ゴースト音声（管理者画面でAの声が聞こえる現象）
- **原因**: roomClient が destroy されないまま残り、subscribe が後続で完了して `<audio>` 要素を document.body に追加し続ける
- **修正**:
  - `_leaveRoomCleanup()` を新設 → `renderHome/renderLobby/renderLeft` 先頭で呼出し（バックボタン経由でも cleanup）
  - `_attachRemoteAudio` で `peerConnection === null`（destroy後）なら生成スキップ

### 2026-06-16: CF セッション stale・大規模修正（`e5ead74` に同梱）

- `renderRoom()` で毎回 POST `/join` して新鮮な CF sessionId を取得（stale session 構造的排除）
- `_setupPeerConnection()` / `_closePeerConnection()` 分離・ICE restart 完全実装
- publish retry（`invalid_session_description` / `session_error` / `wrong state` 検知）
- `_iceRestarting` / `_subscribeRunning` 二重ロックで SDP 操作を直列化
- 全エラーパスで `roomClient.onEvent = () => {}` → `destroy()` → `null` の順序統一
- エラー遷移先を `#/` → ロビーまたは `#/left` に変更

### 2026-06-15 以前（〜`54f57ac`）

| 修正 | 内容 |
|---|---|
| セキュリティ強化 | CORS制限 / WS token認証 / ルーム作成レート制限 |
| 参加リダイレクトループ修正 | `!sessionData.token` → `!sessionData` チェックに変更 |
| 退出後画面新設 | `#/left/:roomId` / 再参加ボタン / 期限切れメッセージ |
| 音声遅延対策 | `voiceChanger.destroy()` を async 化 |
| 音声無音バグ修正 | sessions認証削除 / `_doSubscribe` try-catch削除 |
| 非対称音声バグ修正 | iOS AudioContext競合解消 / cfFetch 502返却 |
