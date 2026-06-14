// ボイスチェンジャー v18
// 位相ロック Phase Vocoder + フォルマントシフト + 2段 EQ
//
// 【v18 改善方針】
//   v17 の問題:
//     - breathMix が高すぎ (5.5〜7%) → 常時ザー音の主原因 → 全て 0 に
//     - pitchRatio / formantRatio が極端すぎ → PVアーティファクト激増
//       悪例: 青山龍星 pitch=0.749 / formant=0.78 → 篭り+ザー音
//             猫使ビィ pitch=1.335 / formant=1.42 → 詐欺音声化
//     - 中部つるぎ (pitch=1.059 / formant=1.12) が「唯一使えるレベル」
//       → これが実用限界の目安
//
//   v18 の安全パラメータ範囲:
//     pitchRatio : 0.84 〜 1.19 (≒ -3st 〜 +3st)
//     formantRatio: 0.90 〜 1.20 (0.90未満 → 篭り激増)
//     breathMix  : 0 (全廃。PVノイズに加算されて悪化するため)
//
//   EQ でキャラ個性を出す戦略:
//     - lowShelf: 体格感・重さ
//     - pkFilter(1段目): 問題帯域のカット / 強調したい帯域のブースト
//     - pk2Filter(2段目): キャラ固有の「色」を追加
//     - highShelf: 空気感・透明感・重厚感

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
  //  ※ formantRatio を 0.90 未満にしない（篭り激増のため）
  // ═══════════════════════════════════════════════════════════

  rito: {
    label: '離途 ♂',
    description: '温かみのある息遣い系男性',
    // -1 半音。やや低めだが重くない。
    pitchRatio: 0.944,
    // -5%。わずかに声道を太く。0.90台なら篭りは出にくい。
    formantRatio: 0.95,
    hpFreq: 70,
    lsFreq: 180,  lsGain:  1.5,           // 180Hz +1.5dB: 温もりの中低域
    pkFreq: 450,  pkGain: -1.0, pkQ: 1.2, // 450Hz -1dB: こもり帯域を軽く除去
    pk2Freq: 3000, pk2Gain: 1.5, pk2Q: 0.8, // 3kHz +1.5dB: 声の通り
    hsFreq: 7000, hsGain:  2.0,           // 7kHz +2dB: 程よい空気感
    breathMix: 0,
  },

  saehaku: {
    label: '黒沢冴白 ♂',
    description: '強気で張りのある硬派男性',
    // -2 半音。落ち着いた権威感。
    pitchRatio: 0.891,
    // -8%。体格感を出しつつ篭りの限界手前。
    formantRatio: 0.92,
    hpFreq: 70,
    lsFreq: 130,  lsGain:  3.5,           // 130Hz +3.5dB: 胸腔の張り・体格感
    pkFreq: 350,  pkGain: -2.0, pkQ: 1.4, // 350Hz -2dB: 箱鳴り除去（篭り予防）
    pk2Freq: 2500, pk2Gain: 3.5, pk2Q: 1.0, // 2.5kHz +3.5dB: 前に出る"張り"
    hsFreq: 5000, hsGain:  2.0,           // 5kHz +2dB: エッジ・切れ味
    breathMix: 0,
  },

  kotaro: {
    label: '白上虎太郎 ♂',
    description: '声変わり直後の少年の声',
    // +1 半音。まだ少し高め。
    pitchRatio: 1.059,
    // +8%。声帯がまだ小さい成長途中。
    formantRatio: 1.08,
    hpFreq: 90,
    lsFreq: 220,  lsGain: -1.0,           // 220Hz -1dB: 胸声を薄く（成長途中感）
    pkFreq: 1200, pkGain:  1.5, pkQ: 2.0, // 1.2kHz +1.5dB 高Q: 声変わりの鋭いピーク
    pk2Freq: 4000, pk2Gain: 2.5, pk2Q: 1.5, // 4kHz +2.5dB: 若さ・荒さのプレゼンス
    hsFreq: 9000, hsGain:  3.5,           // 9kHz +3.5dB: 空気感・若さの粗さ
    breathMix: 0,
  },

  takehiro: {
    label: '玄野武宏 ♂',
    description: '爽やかな青年、清潔感のあるイケメン系',
    // +0.5 半音。わずかに上、爽やか感。
    pitchRatio: 1.026,
    // formantほぼ変えず。EQで爽やかさを作る。
    formantRatio: 1.00,
    hpFreq: 80,
    lsFreq: 200,  lsGain: -0.5,           // 200Hz -0.5dB: わずかに軽くする
    pkFreq: 3000, pkGain:  2.5, pkQ: 1.0, // 3kHz +2.5dB: 爽やかさ・明るみ
    pk2Freq: 800, pk2Gain: -1.0, pk2Q: 1.2, // 800Hz -1dB: 中域の重たさ除去
    hsFreq: 9000, hsGain:  4.0,           // 9kHz +4dB: 清潔感・爽快な空気感
    breathMix: 0,
  },

  ryusei: {
    label: '青山龍星 ♂',
    description: '重厚で低音なバリトン',
    // -3 半音。重いが安全範囲内。（-5st=0.749 は篭りが激しいため却下）
    pitchRatio: 0.841,
    // -10%。safe最低値。篭り防止のため0.90を死守。
    formantRatio: 0.90,
    hpFreq: 50,                            // 50Hz: 低音を最大限残す
    lsFreq: 100,  lsGain:  5.0,           // 100Hz +5dB: 胸腔共鳴の核心（最大ブースト）
    pkFreq: 280,  pkGain: -3.0, pkQ: 1.6, // 280Hz -3dB: こもり帯域徹底除去（重要）
    pk2Freq: 2000, pk2Gain: 2.0, pk2Q: 0.8, // 2kHz +2dB: 子音の聴き取りやすさ維持
    hsFreq: 4500, hsGain:  0,             // 4.5kHz ±0: 高域は変えない（重厚感維持）
    breathMix: 0,
  },

  // ═══════════════════════════════════════════════════════════
  //  女性キャラクター
  //  ※ formantRatio を 1.20 以上にしない（詐欺声化のため）
  // ═══════════════════════════════════════════════════════════

  bii: {
    label: '猫使ビィ ♀',
    description: 'ピュアであどけない子供っぽい声',
    // +3 半音。子供っぽい高さ。（+5st=1.335 は詐欺声化のため却下）
    pitchRatio: 1.189,
    // +18%。safe最高値付近。（1.42 は詐欺声化のため却下）
    formantRatio: 1.18,
    hpFreq: 120,
    lsFreq: 280,  lsGain: -2.5,           // 280Hz -2.5dB: 胸声を引いて幼くする
    pkFreq: 3000, pkGain:  3.5, pkQ: 1.2, // 3kHz +3.5dB: あどけない甘い倍音帯域
    pk2Freq: 900, pk2Gain: -2.0, pk2Q: 1.0, // 900Hz -2dB: 大人感の中域を除去
    hsFreq: 10000, hsGain: 5.0,           // 10kHz +5dB: キラキラした子供らしさ
    breathMix: 0,
  },

  tsurugi: {
    label: '中部つるぎ ♀',
    description: '凛然とした高貴・威厳の女性',
    // +1 半音。凛とした落ち着き。
    pitchRatio: 1.059,
    // +10%。アニメ女性だが「可愛い」方向には踏み込まない。
    formantRatio: 1.10,
    hpFreq: 90,
    lsFreq: 200,  lsGain: -1.5,           // 200Hz -1.5dB: 胸声を引いて威厳の細さ
    pkFreq: 900,  pkGain: -3.0, pkQ: 1.5, // 900Hz -3dB: 「甘さ・可愛さ」の帯域除去（重要）
    pk2Freq: 3000, pk2Gain: 2.0, pk2Q: 0.9, // 3kHz +2dB: 凛とした前に出るプレゼンス
    hsFreq: 8000, hsGain:  2.0,           // 8kHz +2dB: 知性的な透明感
    breathMix: 0,
  },

  zunko: {
    label: '東北ずん子 ♀',
    description: 'しとやかで親しみやすい穏やかな声',
    // +2 半音。やや高め、でも過剰でない。
    pitchRatio: 1.122,
    // +12%。自然なアニメ女性の域。
    formantRatio: 1.12,
    hpFreq: 80,
    lsFreq: 250,  lsGain:  0.5,           // 250Hz +0.5dB: わずかな温もり
    pkFreq: 1500, pkGain:  1.5, pkQ: 1.0, // 1.5kHz +1.5dB: 愛嬌・親しみやすさ
    pk2Freq: 3200, pk2Gain: 1.5, pk2Q: 1.0, // 3.2kHz +1.5dB: しとやかなプレゼンス
    hsFreq: 8000, hsGain:  2.5,           // 8kHz +2.5dB: 空気感
    breathMix: 0,
  },

  mitama: {
    label: '暁記ミタマ ♀',
    description: '儚げで浮遊感のある幻想系',
    // +2 半音。儚さで浮遊感。
    pitchRatio: 1.122,
    // +12%。高めだが子供っぽくない幻想感。
    formantRatio: 1.12,
    hpFreq: 120,                           // 120Hz: 「大地感」をカット = 浮遊感確保
    lsFreq: 280,  lsGain: -2.5,           // 280Hz -2.5dB: 体重感を除去
    pkFreq: 2500, pkGain: -1.0, pkQ: 0.8, // 2.5kHz -1dB: 中域の実在感をわずかに引く
    pk2Freq: 5000, pk2Gain: 2.5, pk2Q: 0.7, // 5kHz +2.5dB: 霧の中の浮遊倍音
    hsFreq: 9000, hsGain:  4.0,           // 9kHz +4dB: 儚い空気感
    breathMix: 0,                          // v18: 0に変更（PVノイズに加算されるため）
  },

  tsumugi: {
    label: '春日部つむぎ ♀',
    description: '元気いっぱいの明るいアニメ声',
    // +3 半音。元気さを感じる高さ。（+4st=1.260 は少し詐欺声寄りのため-1st）
    pitchRatio: 1.189,
    // +18%。明るく前向きなアニメ声。
    formantRatio: 1.18,
    hpFreq: 110,
    lsFreq: 250,  lsGain: -1.5,           // 250Hz -1.5dB: 重さを取る
    pkFreq: 2500, pkGain:  3.5, pkQ: 1.1, // 2.5kHz +3.5dB: 「元気!」の明るい輝き
    pk2Freq: 4500, pk2Gain: 2.5, pk2Q: 1.0, // 4.5kHz +2.5dB: 声の弾み・エネルギー感
    hsFreq: 10000, hsGain: 5.0,           // 10kHz +5dB: 全力の空気感・弾け感
    breathMix: 0,
  },
};

// ─── キャラクターグループ（UI でのカテゴリ表示用）───────────
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
    this.compressor.knee.value      = 16;
    this.compressor.ratio.value     = 3;
    this.compressor.attack.value    = 0.003;
    this.compressor.release.value   = 0.20;

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

    // ─── 息感ノイズチェーン（breathMix > 0 専用。v18時点では全プリセット 0）───
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
    this.breathHPF.frequency.value = 4000; // v18: 3500→4000Hz（PVノイズとの干渉を更に減らす）
    this.breathHPF.Q.value         = 0.7;

    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0; // 全プリセット0のため常に無音

    this.breathSrc.connect(this.breathHPF);
    this.breathHPF.connect(this.breathGain);

    this._buildGraph('none');
    this.outputStream = this.destinationNode.stream;
    return this.outputStream;
  }

  setPreset(presetKey) {
    const key = VOICE_PRESETS[presetKey] ? presetKey : 'none';
    this.currentPreset = key;
    // カスタムパラメータをlocalStorageから読み込んでマージ
    let custom = {};
    try {
      const saved = JSON.parse(localStorage.getItem('voiceCustomParams'));
      if (saved?.[key]) custom = saved[key];
    } catch {}
    this._buildGraphFromParams({ ...VOICE_PRESETS[key], ...custom });
  }

  // リアルタイムスライダー操作用（グラフ再構築なし・スムーズ）
  updateFilterParam(key, value) {
    const ctx = this.audioContext;
    if (!ctx) return;
    const t = ctx.currentTime;
    switch (key) {
      case 'pitchRatio':   this.pitchNode?.parameters.get('pitchRatio').setTargetAtTime(value, t, 0.01); break;
      case 'formantRatio': this.pitchNode?.parameters.get('formantRatio').setTargetAtTime(value, t, 0.01); break;
      case 'lsGain':       this.lsFilter?.gain.setTargetAtTime(value, t, 0.01); break;
      case 'pkFreq':       this.pkFilter?.frequency.setTargetAtTime(value, t, 0.01); break;
      case 'pkGain':       this.pkFilter?.gain.setTargetAtTime(value, t, 0.01); break;
      case 'pk2Freq':      this.pk2Filter?.frequency.setTargetAtTime(value, t, 0.01); break;
      case 'pk2Gain':      this.pk2Filter?.gain.setTargetAtTime(value, t, 0.01); break;
      case 'hsGain':       this.hsFilter?.gain.setTargetAtTime(value, t, 0.01); break;
    }
  }

  // パネルテスト開始時のフル初期化（hpFreqを含むグラフトポロジーも設定）
  setParamsDirect(params) {
    if (!this.audioContext) return;
    this._buildGraphFromParams(params);
  }

  _buildGraph(presetKey) {
    this._buildGraphFromParams(VOICE_PRESETS[presetKey] ?? VOICE_PRESETS.none);
  }

  _buildGraphFromParams(p) {
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
