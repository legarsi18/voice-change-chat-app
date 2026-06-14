# 作戦会議アプリ 進捗メモ

## アプリ概要
ゲームキャラクター風ボイスチェンジャー付き音声会議PWA。

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
# フロントエンドを更新した場合
npx wrangler pages deploy public --project-name voice-change-chat-app --branch master

# Workerを更新した場合
cd worker && npx wrangler deploy && cd ..

# GitHubにも保存
git add -A && git commit -m "変更内容" && git push origin master
```

## アプリ機能（実装済み）
- [x] ホーム画面（管理者パスワード付きルーム作成）
- [x] 招待URL発行（7日間有効なトークン）
- [x] ロビー画面（参加前にアイコン・名前・ボイス設定）
- [x] 設定のlocalStorage引き継ぎ（次回自動入力）
- [x] ボイスチェンジャー5種（素の声・重戦士・少年・ヒロイン・ボーイッシュ）
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
- [x] 再入室バグ修正（DO storage + invite token persistence）
- [x] WebSocket keepalive ping (25秒間隔)

## ボイスチェンジャー設計（現状）

### 採用技術
- **位相ボコーダー（Phase Vocoder）**: N=1024, Ha=128, 8x overlap
- **フォルマントシフト**: 単一比率でスペクトル包絡全体をリマップ（pitchとformantが独立）
- **EQ**: HP + LowShelf + Peaking + HighShelf + DynamicsCompressor
- **息感ノイズ**: ホワイトノイズ → HPF(2500Hz) → Gain（F-1専用）

### 修正済みバグ（Phase Vocoder）
- Bug①: hsAccum で Hs ドリフト防止（声のコピー）
- Bug②: lastReadIntPos で安全クリア（ビー音）
- Bug③: synthPhaseAccum を毎フレーム [0,2π) 正規化（ハム音）

### プリセット設計 - ゲームキャラクターアーキタイプ
ユーザー提供の専門設計仕様（M-1/M-2/F-1/F-2）に基づいて再設計済み（sw.js v13）

| キー | ラベル | pitchRatio | formantRatio | EQ設計 | 息感 |
|---|---|---|---|---|---|
| none | 素の声 | 1.0 | 1.0 | なし | なし |
| male1 | 男性 重戦士 | 0.794 (-4st) | 0.82 | 150Hz+3dB, 2kHz+2dB, 5kHz-3dB | なし |
| male2 | 男性 少年・軽快 | 1.059 (+1st) | 1.10 | HP120Hz, 200Hz-2dB, 4kHz+3dB, 7kHz+1dB | なし |
| female1 | 女性 ヒロイン | 1.189 (+3st) | 1.25 | HP200Hz, 200Hz-2dB, 2.5kHz+3dB, 8kHz+2dB | 0.03 |
| female2 | 女性 ボーイッシュ | 0.944 (-1st) | 0.90 | HP120Hz, 300Hz+2dB, 5kHz-2dB | なし |

### 設計の考え方
- **male1**: formant 0.82（0.78より緩和）でこもり軽減、2kHzプレゼンスで聴き取り改善
- **male2**: formant 1.10でF2上昇→前に出る明るさ、pitchもやや上→少年感
- **female1**: formant 1.25でF2大幅上昇→透明感・清潔感、breathMix=0.03で息漏れ質感
- **female2**: formant 0.90でF1抑制→胸声感・中性感、300Hzで芯を出す

### さらなる品質向上の選択肢（未実装・優先度順）
1. **位相ロック(Phase Locking)**: ミュージカルノイズ削減（最も効果大。難度高）
2. **F1/F2独立シフト**: 周波数帯域ごとにformantRatioを変える
3. **ハーモニックエキサイター**: WaveShaper → BPF のサイドチェーンで倍音付加
4. **過渡検出(Transient Detection)**: 子音部分はPVをバイパス

## 未解決バグ（次回セッションで対応）
### Bug 1: ルーム作成画面クリックで音楽が止まる
- **原因**: `silence.mp3` の keepalive再生が「ページ上の最初のクリック」で発火するため
- **対象ファイル**: `public/index.html`

### Bug 2: テスト再生でマイク許可が毎回出る
- **原因**: テスト後に `stream.stop()` を呼んでいるため
- **修正方針**: テスト用ストリームをキャッシュして使い回す
- **対象ファイル**: `public/js/app.js` の `testVoice` イベントハンドラー

### Bug 3: 参加ボタンで「招待リンクが無効か期限切れです」
- **修正方針**: joinをGET→POSTに変更してトークンをbodyで渡す
- **対象ファイル**: `public/js/app.js`, `worker/src/index.js`

## 次回セッション開始時の手順
1. このファイル（PROGRESS.md）を読む
2. 声のクオリティ検証結果を確認 → 改善が必要なら「さらなる品質向上の選択肢」を実装
3. 未解決バグ3つを順番に修正する
4. 修正後は必ずデプロイ（wrangler pages deploy + push）

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
│       └── room-do.js       ← Durable Object（WebSocketシグナリング・DO storage）
└── public/                  ← Cloudflare Pages（フロントエンド）
    ├── index.html           ← PWA対応HTML
    ├── manifest.json
    ├── sw.js                ← Service Worker (現在 v13)
    ├── silence.mp3          ← iOSバックグラウンド用無音ファイル
    ├── icons/               ← SVGアイコン8種
    ├── css/style.css        ← 全スタイル
    └── js/
        ├── app.js           ← メインUI・ルーティング
        ├── room.js          ← WebRTC + Cloudflare Realtime（pingキープアライブ含む）
        ├── voice-changer.js ← ボイスチェンジャー本体（位相ボコーダー+フォルマント+息感）
        └── worklets/
            └── pitch-shifter.js ← AudioWorkletピッチシフター（バグ3つ修正済み）
```
