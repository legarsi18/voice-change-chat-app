# 作戦会議アプリ 進捗メモ

## アプリ概要
信長の野望 真戦の幹部メンバー向けボイスチェンジャー付き音声会議PWA。

## 本番URL
- **フロントエンド**: https://voice-change-chat-app.pages.dev
- **Worker API**: https://voice-chat-worker.legarsi-18k.workers.dev
- **GitHub**: https://github.com/legarsi18/voice-change-chat-app

## インフラ構成
| サービス | 役割 | 無料枠 |
|---|---|---|
| Cloudflare Pages | フロントエンド静的配信 | 無制限 |
| Cloudflare Workers | API・トークン検証 | 10万req/日 |
| Cloudflare Durable Objects | WebSocketシグナリング | 余裕あり |
| Cloudflare KV | ルーム・トークン保存 | 余裕あり |
| Cloudflare Realtime SFU | 音声中継（SFU） | 1,000GB/月（実質無制限） |

## 管理者情報
- **ルーム作成パスワード**: `aizakura0318`（メンバーには非公開）
- **Cloudflare アカウント**: legarsi.18k@gmail.com
- **GitHub アカウント**: legarsi18

## デプロイ手順
```bash
# Workerを更新した場合
cd worker
npx wrangler deploy

# フロントエンドを更新した場合
cd .. # リポジトリルートへ
npx wrangler pages deploy public --project-name voice-change-chat-app --branch master

# GitHubにも保存
git add -A
git commit -m "変更内容"
git push origin master
```

## アプリ機能（実装済み）
- [x] ホーム画面（管理者パスワード付きルーム作成）
- [x] 招待URL発行（7日間有効なトークン）
- [x] ロビー画面（参加前にアイコン・名前・ボイス設定）
- [x] 設定のlocalStorage引き継ぎ（次回自動入力）
- [x] ボイスチェンジャー5種（素の声・武将・姫・忍者・軍師）
- [x] テスト再生ボタン（※イヤホン推奨）
- [x] 通話画面（参加者アイコン表示・話し中インジケーター）
- [x] 共有メモ機能
- [x] 通話経過時間タイマー（3時間で警告）
- [x] 声の切り替え（通話中も可能）
- [x] ミュートボタン
- [x] PWA対応（ホーム画面追加可能）
- [x] iOSバックグラウンド音声維持（silence.mp3 keepalive）
- [x] 戦国テーマSVGアイコン8種（男性4・女性4）
- [x] アイコン自前アップロード対応

## 未解決バグ（次回セッションで対応）
### Bug 1: ルーム作成画面クリックで音楽が止まる
- **原因**: `silence.mp3` の keepalive再生が「ページ上の最初のクリック」で発火するため
- **修正方針**: keepalive再生をルーム入室後のみに限定する
- **対象ファイル**: `public/index.html`

### Bug 2: テスト再生でマイク許可が毎回出る
- **原因**: テスト後に `stream.stop()` を呼んでいるため、iOSでは次回 `getUserMedia()` 時に再度許可ダイアログが出る
- **修正方針**: テスト用のストリームをページ内でキャッシュして使い回す。またはテスト後に stop しない
- **対象ファイル**: `public/js/app.js` の `testVoice` イベントハンドラー

### Bug 3: 参加ボタンで「招待リンクが無効か期限切れです」
- **原因調査済み**: Worker APIはcurlでは正常動作確認済み。ブラウザ側でのトークン受け渡しに問題の可能性
- **修正方針**:
  1. joinをGET→POSTに変更してトークンをbodyで渡す（URLパラメータ問題を回避）
  2. コンソールログを追加して実際に送られるトークンを確認
  3. フロントエンドのトークン抽出ロジックを見直し
- **対象ファイル**: `public/js/app.js`（join fetch部分）、`worker/src/index.js`（joinエンドポイント）

## 次回セッション開始時の手順
1. このファイル（PROGRESS.md）を読む
2. 「未解決バグ」3つを順番に修正する
3. 修正後は必ずcurlテスト＋ブラウザ実機テストで確認
4. デプロイ手順に従ってWorker・Pages両方を更新する

## ファイル構成
```
voice-change-chat-app/
├── PROGRESS.md              ← このファイル
├── .gitignore
├── worker/                  ← Cloudflare Worker（バックエンド）
│   ├── wrangler.toml        ← KV IDが記載済み
│   ├── package.json
│   └── src/
│       ├── index.js         ← API routes（ルーム作成・参加・WebSocket）
│       └── room-do.js       ← Durable Object（WebSocketシグナリング）
└── public/                  ← Cloudflare Pages（フロントエンド）
    ├── index.html           ← PWA対応HTML
    ├── manifest.json
    ├── sw.js                ← Service Worker
    ├── silence.mp3          ← iOSバックグラウンド用無音ファイル
    ├── icons/               ← SVGアイコン8種
    ├── css/style.css        ← 全スタイル
    └── js/
        ├── app.js           ← メインUI・ルーティング
        ├── room.js          ← WebRTC + Cloudflare Realtime
        ├── voice-changer.js ← ボイスチェンジャー本体
        └── worklets/
            └── pitch-shifter.js ← AudioWorkletピッチシフター
```
