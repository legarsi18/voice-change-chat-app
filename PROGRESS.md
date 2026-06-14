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
npx wrangler pages deploy public --project-name voice-change-chat-app --branch master --commit-dirty=true

# Workerを更新した場合
cd worker && npx wrangler deploy && cd ..

# GitHubにも保存
git add -A && git commit -m "変更内容" && git push origin master
```

---

## ボイスチェンジャー設計（現状 v19）

### 採用技術
- **位相ロック Phase Vocoder (Phase Locking PV)**
  - N=4096（v19で2048から倍増）, Ha=256, **16xオーバーラップ**
  - 周波数分解能: 11.7Hz/bin（v16比で4倍精細）
  - 5パスアルゴリズム（ピーク検出→帰属→位相ロック）
- **フォルマントシフト**: pitchとformantを独立制御（重要）
- **EQ**: HP + LowShelf + Peaking×2 + HighShelf + DynamicsCompressor
- **none（素の声）**: FFT完全スキップ、レイテンシーゼロ・ノイズゼロ

### 修正済みバグ（PV）
- Bug①: hsAccum で Hs ドリフト防止（声のコピー）
- Bug②: lastReadIntPos で安全クリア（ビー音）
- Bug③: synthPhaseAccum を毎フレーム [0,2π) 正規化（ハム音）

### 安全パラメータ範囲（実験で判明した限界値）
```
pitchRatio  : 0.84 〜 1.19（最大 ±3 半音。これ以上は詐欺音声化）
formantRatio: 0.90 〜 1.18（0.90未満は篭り激増。1.20超は詐欺音声化）
breathMix   : 0    （PVノイズに加算されて悪化するため全廃。v17→v18で削除）
```

### gitリバートポイント
```bash
# v16安定版（3バグ修正済みPV、プリセット4種）
git checkout v16-stable -- public/js/voice-changer.js public/sw.js

# v17（VOICEVOXキャラクター10プリセット、パラメータ過激版 ※使用不可レベル）
git checkout v17-voicevox -- public/js/voice-changer.js public/sw.js

# 特定コミットに戻す場合
git log --oneline  # ハッシュ確認
git checkout <hash> -- public/js/voice-changer.js
```

---

## プリセット一覧（v18〜v19 現行）

| キー | ラベル | pitchRatio | formantRatio | 設計の核心 |
|---|---|---|---|---|
| none | 素の声 | 1.0 | 1.0 | エフェクトなし（FFTスキップ） |
| rito | 離途 ♂ | 0.944 | 0.95 | 温もり系、180Hz+1.5dB |
| saehaku | 黒沢冴白 ♂ | 0.891 | 0.92 | 強気・張り系、130Hz+3.5dB、2.5kHz+3.5dB |
| kotaro | 白上虎太郎 ♂ | 1.059 | 1.08 | 少年系、1.2kHz高QピークでBoy感 |
| takehiro | 玄野武宏 ♂ | 1.026 | 1.00 | 爽やか系、3kHz+2.5dB、9kHz+4dB |
| ryusei | 青山龍星 ♂ | 0.841 | 0.90 | バリトン系、100Hz+5dB（formant 0.90が安全下限） |
| bii | 猫使ビィ ♀ | 1.189 | 1.18 | 幼い系、3kHz+3.5dB、10kHz+5dB |
| tsurugi | 中部つるぎ ♀ | 1.059 | 1.10 | 凛系、900Hz-3dBで甘さ除去 |
| zunko | 東北ずん子 ♀ | 1.122 | 1.12 | 親しみ系、1.5kHz+1.5dB |
| mitama | 暁記ミタマ ♀ | 1.122 | 1.12 | 儚い系、120HzHP+5kHz+2.5dB |
| tsumugi | 春日部つむぎ ♀ | 1.189 | 1.18 | 元気系、2.5kHz+3.5dB、10kHz+5dB |

---

## 既知の未解決問題

### ① 篭り・機械的な音（最重要 → 次回セッションで対応）
- **状況**: 常時ザー音はv18で解決。篭りと機械的な音は残存。
- **根本**: PV固有のアーティファクト。位相ロックで削減済みだが完全解消は困難。
- **方針**: UIパラメータ調整機能を実装し、ユーザー自身が音を作れるようにする。

### ② 旧来バグ（対応保留中）
- Bug A: ルーム作成画面クリックで音楽が止まる（silence.mp3 keepalive）
- Bug B: テスト再生でマイク許可が毎回出る（stream.stop()後にキャッシュがない）
- Bug C: 参加ボタンで「招待リンクが無効か期限切れ」エラー（GET→POST化が必要）

---

## ★ 次回セッションタスク：パラメータ調整UI実装

### 目的
篭りや機械的な音を、ユーザー自身がパラメータ操作で改善できるようにする。

### 実装場所
**URL作成ページ（管理者ログイン後の画面）の下**に「ボイス調整パネル」セクションを追加。

### 機能仕様

#### 1. ボイス一覧 + スライダー
- 10キャラクター + 素の声がリストで並ぶ
- 各ボイスを展開するとパラメータスライダーが表示される

#### 2. 調整できるパラメータとスライダー説明文
| パラメータ | 表示名 | 説明文（UI表示用） | 推奨範囲 |
|---|---|---|---|
| pitchRatio | 声の高低 | 低くしたい→下げる / 高くしたい→上げる / 機械感が増したら戻す | 0.84〜1.19 |
| formantRatio | 声の太細 | 篭りがひどい→1.0に近づける / キャラ感を出したい→離す（※要注意） | 0.90〜1.18 |
| lsGain | 低音の強さ | 重くしたい→上げる / 軽くしたい・篭る→下げる | -4〜+5 dB |
| pkFreq | 中域EQの周波数 | 篭る帯域を特定してその周波数を設定（人の声の主要域: 300〜3000Hz） | 200〜4000 Hz |
| pkGain | 中域EQの強さ | 篭りをカット→下げる / 前に出したい→上げる | -6〜+6 dB |
| pk2Freq | 中高域EQの周波数 | プレゼンス・明るさの調整（主要域: 2000〜6000Hz） | 1000〜8000 Hz |
| pk2Gain | 中高域EQの強さ | 明るくしたい・キャラ感→上げる / 耳障り・ノイズっぽい→下げる | -6〜+6 dB |
| hsGain | 高音・空気感 | シャリシャリ感・空気感→上げる / ノイズっぽい・機械的→下げる | -3〜+6 dB |

#### 3. ボタン
- **「▶ テスト再生」ボタン**: マイク音声をリアルタイムプレビュー（スライダーを動かしながら確認）
- **「💾 保存」ボタン**: localStorageにカスタム値を保存（次回起動時も維持）
- **「↩ デフォルトに戻す」ボタン**: voice-changer.jsのデフォルト値にリセット

### データ保持の仕様
```javascript
// localStorageに保存するキー（既存のprofileとは別）
'voiceCustomParams' = {
  rito: { pitchRatio: 0.944, formantRatio: 0.95, lsGain: 1.5, ... },
  saehaku: { ... },
  ...
}

// 読み込み優先順位
// カスタム保存値 → VOICE_PRESETS デフォルト値
```

### 関連ファイル（修正が必要なもの）
| ファイル | 変更内容 |
|---|---|
| `public/js/app.js` | パラメータUI描画・localSave/Load・テスト再生ロジック |
| `public/css/style.css` | スライダーのスタイル追加 |
| `public/index.html` | パネルのHTML挿入（管理者画面の下） |
| `public/js/voice-changer.js` | setPreset()でカスタム値を優先的に使う処理を追加 |

---

## アプリ機能（実装済み）
- [x] ホーム画面（管理者パスワード付きルーム作成）
- [x] 招待URL発行（7日間有効なトークン）
- [x] ロビー画面（参加前にアイコン・名前・ボイス設定）
- [x] 設定のlocalStorage引き継ぎ（次回自動入力）
- [x] ボイスチェンジャー11種（素の声+VOICEVOXキャラクター10種）
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
- [x] 位相ロックPV（ムジカルノイズ削減）
- [x] N=4096 高精度FFT（16xオーバーラップ、11.7Hz/bin解像度）

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
    ├── sw.js                ← Service Worker (現在 v19)
    ├── silence.mp3          ← iOSバックグラウンド用無音ファイル
    ├── icons/               ← SVGアイコン8種
    ├── css/style.css        ← 全スタイル
    └── js/
        ├── app.js           ← メインUI・ルーティング（VOICE_PRESETSからUI自動生成）
        ├── room.js          ← WebRTC + Cloudflare Realtime（pingキープアライブ含む）
        ├── voice-changer.js ← ボイスチェンジャー本体（PV+フォルマント+EQ）
        └── worklets/
            └── pitch-shifter.js ← AudioWorkletピッチシフター（N=4096 位相ロックPV）
```
