// ボイスチェンジャー v16
// 位相ロック Phase Vocoder + フォルマントシフト + 2段 EQ + 息感ノイズ
//
// 【EQ 設計（音声品質専門家監修）】
//   処理チェーン: source → pitchNode → HP → LS → PK1 → PK2 → HS → compressor
//
//   PK1/PK2 の 2 段ピーキングで各アーキタイプのEQ特性を正確に再現:
//     M-1 重戦士: 400Hzカット(こもり除去) + 1800Hzブースト(子音明瞭度)
//     M-2 少年:   3kHzブースト(前に出る切れ味) + PK2はニュートラル
//     F-1 ヒロイン: 2.5kHzブースト(透明感) + 息感ノイズ(5%/3500Hz以上)
//     F-2 ボーイッシュ: 800Hzカット(中性感・ガーリー除去) + PK2はニュートラル
//
// 【プリセット優先順位（音声品質専門家より）】
//   フォルマント比率 > EQ > ピッチ比率
//   → formantRatio の設計が最も重要

export const VOICE_PRESETS = {
  none: {
    label: '素の声',
    description: 'エフェクトなし（FFTスキップ・完全スルー）',
    pitchRatio: 1.0, formantRatio: 1.0,
    hpFreq: null,
    lsFreq: 200,  lsGain:  0,
    pkFreq: 1000, pkGain:  0, pkQ: 1.0,
    pk2Freq: 2000, pk2Gain: 0, pk2Q: 1.0,
    hsFreq: 5000, hsGain:  0,
    breathMix: 0,
  },

  male1: {
    label: '男性 重戦士',
    description: '重みと威圧感のある武人系キャラ',
    // ピッチ: -4 半音
    pitchRatio: 0.794,
    // フォルマント: -18%（大柄な体格感。0.78より緩和してこもり軽減）
    formantRatio: 0.82,
    hpFreq: 60,                        // 60Hz: ローエンドノイズ除去・胸声は残す
    lsFreq: 120,  lsGain:  4,          // 120Hz +4dB: 胸腔共鳴（重量感）
    pkFreq: 400,  pkGain: -3.5, pkQ: 1.5,  // 400Hz -3.5dB: こもり・箱鳴り除去（最重要）
    pk2Freq: 1800, pk2Gain: 2.5, pk2Q: 0.9, // 1.8kHz +2.5dB: 子音明瞭度・プレゼンス
    hsFreq: 5000, hsGain:  1,          // 5kHz +1dB: 全体の抜け感を少し維持
    breathMix: 0,
  },

  male2: {
    label: '男性 少年・軽快',
    description: '明るく前に出る俊敏な少年系キャラ',
    // ピッチ: +1 半音（少年感）
    pitchRatio: 1.059,
    // フォルマント: +10%（F2 上昇 → 前に出る明るさ）
    formantRatio: 1.10,
    hpFreq: 120,                       // 120Hz: 低域カット（軽さ）
    lsFreq: 200,  lsGain: -2,          // 200Hz -2dB: 低域スリム化
    pkFreq: 3000, pkGain:  3, pkQ: 1.2, // 3kHz +3dB: 「前に出る」切れ味・子音立ち
    pk2Freq: 2000, pk2Gain: 0, pk2Q: 1.0, // PK2: ニュートラル
    hsFreq: 8000, hsGain:  4,          // 8kHz +4dB: 空気感・若さ
    breathMix: 0,
  },

  female1: {
    label: '女性 ヒロイン',
    description: '透明感・清楚さのあるヒロイン系キャラ',
    // ピッチ: +3 半音
    pitchRatio: 1.189,
    // フォルマント: +25%（F2 大幅上昇 → /i/ /e/ の透明感・清潔感）
    formantRatio: 1.25,
    hpFreq: 100,                       // 100Hz: 低域クリア
    lsFreq: 250,  lsGain: -1,          // 250Hz -1dB: 胸声を少し引く
    pkFreq: 2500, pkGain:  2, pkQ: 0.9, // 2.5kHz +2dB: 透明感・キラキラ感
    pk2Freq: 2000, pk2Gain: 0, pk2Q: 1.0, // PK2: ニュートラル
    hsFreq: 10000, hsGain: 5,          // 10kHz +5dB: 空気感・清楚さ
    breathMix: 0.06,                   // 息漏れ 6%（専門家推奨: 5-7%）
  },

  female2: {
    label: '女性 ボーイッシュ',
    description: '芯の強い中性的な女性戦士キャラ',
    // ピッチ: -1 半音（ほぼ変えない）
    pitchRatio: 0.944,
    // フォルマント: -10%（F1 下げ → 胸声感・中性感）
    formantRatio: 0.90,
    hpFreq: 80,                        // 80Hz
    lsFreq: 150,  lsGain:  2,          // 150Hz +2dB: 200〜400Hz コア（芯）
    pkFreq: 800,  pkGain: -2, pkQ: 1.0, // 800Hz -2dB: 「女性っぽさ」の鼻腔中域を除去
    pk2Freq: 2000, pk2Gain: 0, pk2Q: 1.0, // PK2: ニュートラル
    hsFreq: 6000, hsGain:  2,          // 6kHz +2dB: 適度なエッジ感
    breathMix: 0,
  },
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
    this.pk2Filter       = null;   // 【新規】第2ピーキングフィルター
    this.hsFilter        = null;
    this.compressor      = null;
    this.speakerGain     = null;
    this.destinationNode = null;
    // 息感ノイズチェーン（F-1 ヒロイン専用）
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

    // ─── EQ フィルター群 ───
    this.hpFilter = ctx.createBiquadFilter();
    this.hpFilter.type    = 'highpass';
    this.hpFilter.Q.value = 0.7;

    this.lsFilter = ctx.createBiquadFilter();
    this.lsFilter.type = 'lowshelf';

    this.pkFilter = ctx.createBiquadFilter();
    this.pkFilter.type = 'peaking';

    this.pk2Filter = ctx.createBiquadFilter();  // 【新規】
    this.pk2Filter.type = 'peaking';

    this.hsFilter = ctx.createBiquadFilter();
    this.hsFilter.type = 'highshelf';

    // ─── ダイナミクスコンプレッサー ───
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

    // iOS バックグラウンド対策（無音オシレーター）
    const kaOsc  = ctx.createOscillator();
    const kaGain = ctx.createGain();
    kaGain.gain.value = 0;
    kaOsc.connect(kaGain);
    kaGain.connect(ctx.destination);
    kaOsc.start();

    // ─── 息感ノイズチェーン（F-1 ヒロイン専用）───────────────
    // ホワイトノイズ → HPF(3500Hz) → breathGain → compressor
    // breathGain.gain=0 のとき無音 → 他プリセットに完全に影響なし
    //
    // 専門家推奨:
    //   - HPF を 2500Hz → 3500Hz に変更（低域ノイズ混入防止）
    //   - mix を 3% → 6% に変更（聴こえる息感に）
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
    this.breathHPF.frequency.value = 3500;  // 専門家推奨: 3500Hz（旧 2500Hz）
    this.breathHPF.Q.value         = 0.7;

    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;

    this.breathSrc.connect(this.breathHPF);
    this.breathHPF.connect(this.breathGain);
    // ──────────────────────────────────────────────────────────

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

    // ─── 既存接続を全解除 ───
    try { this.sourceNode.disconnect();  } catch {}
    try { this.pitchNode.disconnect();   } catch {}
    try { this.hpFilter.disconnect();    } catch {}
    try { this.lsFilter.disconnect();    } catch {}
    try { this.pkFilter.disconnect();    } catch {}
    try { this.pk2Filter.disconnect();   } catch {}
    try { this.hsFilter.disconnect();    } catch {}
    try { this.compressor.disconnect();  } catch {}
    try { this.breathGain.disconnect();  } catch {}

    // ─── ピッチ・フォルマント設定 ───
    this.pitchNode.parameters.get('pitchRatio').value   = p.pitchRatio;
    this.pitchNode.parameters.get('formantRatio').value = p.formantRatio ?? 1.0;

    // ─── EQ 設定 ───
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

    // ─── 息感ノイズ ───
    this.breathGain.gain.value = p.breathMix ?? 0;

    // ─── グラフ接続 ───
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
    this.pkFilter.connect(this.pk2Filter);  // 【新規】PK → PK2
    this.pk2Filter.connect(this.hsFilter);  // 【新規】PK2 → HS
    this.hsFilter.connect(this.compressor);

    // 息感ノイズ → comp（breathMix=0 のときは接続するが gain=0 = 無音）
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
