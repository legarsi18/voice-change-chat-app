// ボイスチェンジャー v17
// 位相ロック Phase Vocoder + フォルマントシフト + 2段 EQ + 息感ノイズ
//
// 【重要な前提説明】
//   本実装は「人間音声をアニメ・ゲームキャラクター声の方向に変換」します。
//   VOICEVOXのような完全合成音声との完全一致は現技術制約上不可能ですが、
//   各キャラクターの声の「方向性・雰囲気・個性」を強く寄せることを目標とします。
//
// 【プリセット設計思想】
//   VOICEVOX の各キャラクター特性を解析し、以下の3軸でアプローチ:
//   ① formantRatio  : 声道長（体格・声の太細）— 最重要（キャラ感の8割）
//   ② pitchRatio    : 基本周波数（音の高低）
//   ③ EQ (2段 PK)  : キャラクター固有の帯域特性
//   ④ breathMix     : 息感・儚さ・柔らかさ
//
// 【10キャラクター設計（VOICEVOX参照）】
//   男性5: 離途 / 黒沢冴白 / 白上虎太郎 / 玄野武宏 / 青山龍星
//   女性5: 猫使ビィ / 中部つるぎ / 東北ずん子 / 暁記ミタマ / 春日部つむぎ

export const VOICE_PRESETS = {
  // ─── 素の声 ────────────────────────────────────────────────
  none: {
    label: '素の声',
    description: 'エフェクトなし',
    pitchRatio: 1.0, formantRatio: 1.0,
    hpFreq: null,
    lsFreq: 200,  lsGain:  0,
    pkFreq: 1000, pkGain:  0, pkQ: 1.0,
    pk2Freq: 2000, pk2Gain: 0, pk2Q: 1.0,
    hsFreq: 5000, hsGain:  0,
    breathMix: 0,
  },

  // ═══════════════════════════════════════════════════════════
  //  男性キャラクター
  // ═══════════════════════════════════════════════════════════

  rito: {
    label: '離途 ♂',
    description: '包み込む息遣いな声 — 温かみのある息漏れ系男性',
    // ピッチ: -1 半音。やや低めだが重くない、吐息で包む感じ
    pitchRatio: 0.944,
    // フォルマント: -7%。小柄な男性体格、女性に近い温かみ
    formantRatio: 0.93,
    hpFreq: 60,
    lsFreq: 180,  lsGain:  1.5,           // 180Hz +1.5dB: 温もりの中低域
    pkFreq: 500,  pkGain: -1.5, pkQ: 1.2, // 500Hz -1.5dB: こもりを薄く除去
    pk2Freq: 3500, pk2Gain: 1.0, pk2Q: 0.8, // 3.5kHz +1dB: 息の抜け感
    hsFreq: 8000, hsGain:  2.5,           // 8kHz +2.5dB: 吐息の空気感
    breathMix: 0.055,                      // 5.5%: 「包み込む息遣い」の核心
  },

  saehaku: {
    label: '黒沢冴白 ♂',
    description: '強気で張りのある声 — 力強く前に出る硬派男性',
    // ピッチ: -2 半音。落ち着いた権威感
    pitchRatio: 0.891,
    // フォルマント: -14%。しっかりした体格、強者の声帯太さ
    formantRatio: 0.86,
    hpFreq: 70,
    lsFreq: 130,  lsGain:  3.0,           // 130Hz +3dB: 胸腔の張り・体格感
    pkFreq: 350,  pkGain: -2.5, pkQ: 1.4, // 350Hz -2.5dB: 箱鳴り除去（強さを濁らせない）
    pk2Freq: 2200, pk2Gain: 3.5, pk2Q: 1.0, // 2.2kHz +3.5dB: "張り"=プレゼンス強調
    hsFreq: 5000, hsGain:  1.5,           // 5kHz +1.5dB: エッジ・切れ味
    breathMix: 0,                          // 息感なし: 強気なキャラには不要
  },

  kotaro: {
    label: '白上虎太郎 ♂',
    description: '声変わり直後の少年の声 — わずかな不安定さと粗さ',
    // ピッチ: +1.5 半音。まだ少し高め、でも純少年より低い
    pitchRatio: 1.091,
    // フォルマント: +8%。声帯はまだ小さい、成長途中
    formantRatio: 1.08,
    hpFreq: 90,
    lsFreq: 220,  lsGain: -1.0,           // 220Hz -1dB: 胸声を薄く（成長途中）
    pkFreq: 1200, pkGain:  1.5, pkQ: 2.0, // 1.2kHz +1.5dB 高Q: 声変わりの不安定な中域ピーク
    pk2Freq: 4000, pk2Gain: 2.0, pk2Q: 1.5, // 4kHz +2dB: 若さ・荒さのプレゼンス
    hsFreq: 9000, hsGain:  3.0,           // 9kHz +3dB: 空気感・粗さ
    breathMix: 0.02,                       // 2%: 喉の不安定感（ごくわずかな roughness）
  },

  takehiro: {
    label: '玄野武宏 ♂',
    description: '爽やかな青年の声 — 清潔感と明るさのイケメン系',
    // ピッチ: +0.5 半音。少しだけ上、爽やか感
    pitchRatio: 1.026,
    // フォルマント: ほぼ変化なし。「普通の男性」ベースに EQ で色をつける
    formantRatio: 1.00,
    hpFreq: 80,
    lsFreq: 200,  lsGain: -0.5,           // 200Hz -0.5dB: わずかに軽くする
    pkFreq: 2800, pkGain:  2.5, pkQ: 1.0, // 2.8kHz +2.5dB: 爽やかさの「明るみ」
    pk2Freq: 800, pk2Gain: -1.5, pk2Q: 1.2, // 800Hz -1.5dB: 中域の「重たさ」除去
    hsFreq: 10000, hsGain: 4.0,           // 10kHz +4dB: 清潔感・爽快な空気感
    breathMix: 0.01,                       // 1%: 清爽感の仕上げ
  },

  ryusei: {
    label: '青山龍星 ♂',
    description: '重厚で低音な声 — 圧倒的な低域共鳴バリトン',
    // ピッチ: -5 半音。最も低いピッチ設定
    pitchRatio: 0.749,
    // フォルマント: -22%。最大の体格感、F1下降で胸腔共鳴を最大化
    formantRatio: 0.78,
    hpFreq: 50,                            // 50Hz: 最低限のノイズカット、低音を最大限残す
    lsFreq: 100,  lsGain:  5.0,           // 100Hz +5dB: 胸腔共鳴の核心（最大ブースト）
    pkFreq: 300,  pkGain: -4.0, pkQ: 1.6, // 300Hz -4dB: こもり帯域の徹底除去
    pk2Freq: 1500, pk2Gain: 1.5, pk2Q: 0.8, // 1.5kHz +1.5dB: 子音の聴き取りやすさ維持
    hsFreq: 4000, hsGain: -1.0,           // 4kHz -1dB: 高域を少し抑えて重厚感を強調
    breathMix: 0,                          // 息感なし: 重厚感の純粋さを保つ
  },

  // ═══════════════════════════════════════════════════════════
  //  女性キャラクター
  // ═══════════════════════════════════════════════════════════

  bii: {
    label: '猫使ビィ ♀',
    description: 'ピュアであどけない声 — 純粋無垢な幼さ・子供っぽさ',
    // ピッチ: +5 半音。子供っぽい高さ
    pitchRatio: 1.335,
    // フォルマント: +42%。非常に高いF2 → 幼児〜子供の声帯長（最大値に近い）
    formantRatio: 1.42,
    hpFreq: 150,                           // 150Hz: 低域をしっかりカット（幼さに低域は不要）
    lsFreq: 300,  lsGain: -2.0,           // 300Hz -2dB: 胸声を引く
    pkFreq: 3500, pkGain:  4.0, pkQ: 1.2, // 3.5kHz +4dB: 「あどけなさ」の甘い倍音帯域
    pk2Freq: 1000, pk2Gain: -1.5, pk2Q: 1.0, // 1kHz -1.5dB: 大人感の中域を除去
    hsFreq: 10000, hsGain: 5.0,           // 10kHz +5dB: キラキラした子供らしさ
    breathMix: 0.03,                       // 3%: 子供特有の息漏れ感
  },

  tsurugi: {
    label: '中部つるぎ ♀',
    description: '凛然とした存在感のある声 — 高貴・冷静・威厳の女性',
    // ピッチ: +1 半音。少し高め、でも凛とした落ち着き
    pitchRatio: 1.059,
    // フォルマント: +12%。アニメ女性だが「可愛い」帯域には踏み込まない
    formantRatio: 1.12,
    hpFreq: 90,
    lsFreq: 200,  lsGain: -1.5,           // 200Hz -1.5dB: 胸声を引いて威厳のある細さ
    pkFreq: 900,  pkGain: -3.0, pkQ: 1.5, // 900Hz -3dB: 「可愛さ・甘さ」の除去（最重要）
    pk2Freq: 3000, pk2Gain: 2.0, pk2Q: 0.9, // 3kHz +2dB: 凛とした前に出るプレゼンス
    hsFreq: 8000, hsGain:  2.0,           // 8kHz +2dB: 知性的な透明感
    breathMix: 0,                          // 息感なし: 凛とした硬質感
  },

  zunko: {
    label: '東北ずん子 ♀',
    description: 'しとやかで愛嬌のある声 — 穏やかで親しみやすい',
    // ピッチ: +2 半音。やや高め、でも過剰でない
    pitchRatio: 1.122,
    // フォルマント: +18%。アニメ女性の自然な域、過剰に高くない
    formantRatio: 1.18,
    hpFreq: 80,
    lsFreq: 250,  lsGain:  0.5,           // 250Hz +0.5dB: わずかな温もり
    pkFreq: 1500, pkGain:  1.5, pkQ: 1.0, // 1.5kHz +1.5dB: 「愛嬌」の中域（親しみやすさ）
    pk2Freq: 3200, pk2Gain: 1.5, pk2Q: 1.0, // 3.2kHz +1.5dB: 明るさ・しとやかなプレゼンス
    hsFreq: 8000, hsGain:  2.5,           // 8kHz +2.5dB: 空気感
    breathMix: 0.02,                       // 2%: しとやかな息感
  },

  mitama: {
    label: '暁記ミタマ ♀',
    description: '儚げで浮遊感のある声 — 霧の中を漂う幻想系',
    // ピッチ: +2.5 半音。やや高めだが儚さで重くない
    pitchRatio: 1.155,
    // フォルマント: +22%。高め、でも子供っぽくない幻想感
    formantRatio: 1.22,
    hpFreq: 120,                           // 120Hz: 「大地感」をカット = 浮遊感の確保
    lsFreq: 280,  lsGain: -2.5,           // 280Hz -2.5dB: 体重感をしっかり除去
    pkFreq: 2000, pkGain: -1.0, pkQ: 0.8, // 2kHz -1dB: 中域の実在感をわずかに引く
    pk2Freq: 4500, pk2Gain: 3.0, pk2Q: 0.7, // 4.5kHz +3dB: 「霧の中の倍音」浮遊成分
    hsFreq: 9000, hsGain:  4.0,           // 9kHz +4dB: 儚い空気感・霞
    breathMix: 0.07,                       // 7%: 浮遊感の核心（最大クラス）
  },

  tsumugi: {
    label: '春日部つむぎ ♀',
    description: '元気な明るい声 — 元気いっぱいの明るいアニメ声',
    // ピッチ: +4 半音。元気さを感じる高さ
    pitchRatio: 1.260,
    // フォルマント: +32%。高いF2 — 明るく前向きなアニメ声
    formantRatio: 1.32,
    hpFreq: 110,
    lsFreq: 250,  lsGain: -1.5,           // 250Hz -1.5dB: 重さを取る
    pkFreq: 2500, pkGain:  3.5, pkQ: 1.1, // 2.5kHz +3.5dB: 「元気!」の明るい輝き
    pk2Freq: 4000, pk2Gain: 2.5, pk2Q: 1.0, // 4kHz +2.5dB: 声の弾み・エネルギー感
    hsFreq: 10000, hsGain: 5.0,           // 10kHz +5dB: 全力の空気感・弾け感
    breathMix: 0.015,                      // 1.5%: ごくわずかな息感（張り声を保持）
  },
};

// ─── キャラクターグループ（ UI でのカテゴリ表示用）───────────
export const VOICE_GROUPS = {
  '素の声': ['none'],
  '男性キャラクター': ['rito', 'saehaku', 'kotaro', 'takehiro', 'ryusei'],
  '女性キャラクター': ['bii', 'tsurugi', 'zunko', 'mitama', 'tsumugi'],
};

export class VoiceChanger {
  constructor(externalAudioContext = null) {
    this._externalAudioContext = externalAudioContext;
    this.audioContext    = null;
    this.sourceNode      = null;
    this.pitchNode       = null;
    this.hpFilter        = null;
    this.lsFilter        = null;
    this.pkFilter        = null;
    this.pk2Filter       = null;
    this.hsFilter        = null;
    this.compressor      = null;
    this.speakerGain     = null;
    this.destinationNode = null;
    this.breathSrc       = null;
    this.breathHPF       = null;
    this.breathGain      = null;
    this.stream          = null;
    this.outputStream    = null;
    this.currentPreset   = 'none';
  }

  async init(stream) {
    this.stream = stream;

    if (this._externalAudioContext) {
      this.audioContext = this._externalAudioContext;
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
    } else {
      this.audioContext = new AudioContext({ sampleRate: 48000 });
    }

    const ctx = this.audioContext;

    await ctx.audioWorklet.addModule('/js/worklets/pitch-shifter.js');

    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.pitchNode  = new AudioWorkletNode(ctx, 'pitch-shifter');

    this.hpFilter = ctx.createBiquadFilter();
    this.hpFilter.type    = 'highpass';
    this.hpFilter.Q.value = 0.7;

    this.lsFilter = ctx.createBiquadFilter();
    this.lsFilter.type = 'lowshelf';

    this.pkFilter = ctx.createBiquadFilter();
    this.pkFilter.type = 'peaking';

    this.pk2Filter = ctx.createBiquadFilter();
    this.pk2Filter.type = 'peaking';

    this.hsFilter = ctx.createBiquadFilter();
    this.hsFilter.type = 'highshelf';

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value      = 12;
    this.compressor.ratio.value     = 4;
    this.compressor.attack.value    = 0.005;
    this.compressor.release.value   = 0.15;

    this.destinationNode = ctx.createMediaStreamDestination();

    this.speakerGain = ctx.createGain();
    this.speakerGain.gain.value = 0;
    this.speakerGain.connect(ctx.destination);

    // iOS バックグラウンド対策
    const kaOsc  = ctx.createOscillator();
    const kaGain = ctx.createGain();
    kaGain.gain.value = 0;
    kaOsc.connect(kaGain);
    kaGain.connect(ctx.destination);
    kaOsc.start();

    // ─── 息感ノイズチェーン（breathMix > 0 のプリセット専用）───
    // ホワイトノイズ → HPF(3500Hz) → breathGain → compressor
    const noiseLen = ctx.sampleRate;
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;

    this.breathSrc = ctx.createBufferSource();
    this.breathSrc.buffer = noiseBuf;
    this.breathSrc.loop   = true;
    this.breathSrc.start();

    this.breathHPF = ctx.createBiquadFilter();
    this.breathHPF.type            = 'highpass';
    this.breathHPF.frequency.value = 3500;
    this.breathHPF.Q.value         = 0.7;

    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;

    this.breathSrc.connect(this.breathHPF);
    this.breathHPF.connect(this.breathGain);

    this._buildGraph('none');
    this.outputStream = this.destinationNode.stream;
    return this.outputStream;
  }

  setPreset(presetKey) {
    const key = VOICE_PRESETS[presetKey] ? presetKey : 'none';
    this.currentPreset = key;
    this._buildGraph(key);
  }

  _buildGraph(presetKey) {
    const p   = VOICE_PRESETS[presetKey] ?? VOICE_PRESETS.none;
    const ctx = this.audioContext;
    if (!ctx) return;

    try { this.sourceNode.disconnect();  } catch {}
    try { this.pitchNode.disconnect();   } catch {}
    try { this.hpFilter.disconnect();    } catch {}
    try { this.lsFilter.disconnect();    } catch {}
    try { this.pkFilter.disconnect();    } catch {}
    try { this.pk2Filter.disconnect();   } catch {}
    try { this.hsFilter.disconnect();    } catch {}
    try { this.compressor.disconnect();  } catch {}
    try { this.breathGain.disconnect();  } catch {}

    this.pitchNode.parameters.get('pitchRatio').value   = p.pitchRatio;
    this.pitchNode.parameters.get('formantRatio').value = p.formantRatio ?? 1.0;

    this.lsFilter.frequency.value  = p.lsFreq   ?? 200;
    this.lsFilter.gain.value       = p.lsGain   ?? 0;
    this.pkFilter.frequency.value  = p.pkFreq   ?? 1000;
    this.pkFilter.gain.value       = p.pkGain   ?? 0;
    this.pkFilter.Q.value          = p.pkQ      ?? 1.0;
    this.pk2Filter.frequency.value = p.pk2Freq  ?? 2000;
    this.pk2Filter.gain.value      = p.pk2Gain  ?? 0;
    this.pk2Filter.Q.value         = p.pk2Q     ?? 1.0;
    this.hsFilter.frequency.value  = p.hsFreq   ?? 5000;
    this.hsFilter.gain.value       = p.hsGain   ?? 0;

    this.breathGain.gain.value = p.breathMix ?? 0;

    // source → pitch → [HP →] LS → PK → PK2 → HS → comp → dest
    this.sourceNode.connect(this.pitchNode);

    if (p.hpFreq) {
      this.hpFilter.frequency.value = p.hpFreq;
      this.pitchNode.connect(this.hpFilter);
      this.hpFilter.connect(this.lsFilter);
    } else {
      this.pitchNode.connect(this.lsFilter);
    }

    this.lsFilter.connect(this.pkFilter);
    this.pkFilter.connect(this.pk2Filter);
    this.pk2Filter.connect(this.hsFilter);
    this.hsFilter.connect(this.compressor);
    this.breathGain.connect(this.compressor);
    this.compressor.connect(this.destinationNode);
    this.compressor.connect(this.speakerGain);
  }

  setMonitor(enabled) {
    if (this.speakerGain) {
      this.speakerGain.gain.value = enabled ? 1.0 : 0;
    }
  }

  async resume() {
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  destroy() {
    this.breathSrc?.stop();
    this.sourceNode?.disconnect();
    this.audioContext?.close();
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
