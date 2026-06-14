// ボイスチェンジャー：位相ボコーダー + マルチバンドEQ + サチュレーション
//
// 【アーキテクチャ】
// source → pitchNode(AudioWorklet) → hpFilter → lsFilter → pkFilter → hsFilter
//        → saturationNode → ringModGain → [dry/wet分岐] → compressor → destination
//
// 【プリセット設計指針】
//   戦国テーマのキャラクター声は「ピッチ変化」だけでなく
//   「EQでフォルマント感を演出」「サチュレーションで質感を追加」
//   「リバーブで空間を演出」の組み合わせで実現する

export const VOICE_PRESETS = {
  none: {
    label: '素の声',
    description: 'エフェクトなし',
    pitchRatio: 1.0,
    hpFreq: null,
    lsFreq: 200, lsGain: 0,
    pkFreq: null, pkGain: 0,
    hsFreq: 5000, hsGain: 0,
    saturation: 0,
    ringMod: 0,
    reverbMix: 0,
  },

  busho: {
    label: '武将',
    description: '重みのある落ち着いた低音',
    // ▼ -4半音: 少しだけ低く（以前-5は低すぎてこもりの原因）
    pitchRatio: 0.794,
    // ▼ 低域ブースト控えめ(+3dB)、高域カット小さく(-2dB) → 籠り感を解消
    hpFreq: null,
    lsFreq: 250, lsGain:  3,
    pkFreq: 400, pkGain:  2,
    hsFreq: 4500, hsGain: -2,
    // ▼ サチュレーション控えめ
    saturation: 0.12,
    ringMod: 0,
    // ▼ エコー解消: 0.28 → 0.07 (かすかな空間感だけ残す)
    reverbMix: 0.07,
  },

  hime: {
    label: '姫',
    description: '明るく通る女性の声',
    // ▼ +3半音に縮小: ピッチシフト量を減らすとPVアーティファクト（ビリビリ音）が激減
    pitchRatio: 1.189,
    // ▼ EQを控えめに: 過剰なブーストがビリビリ音の原因のひとつ
    hpFreq: 180,
    lsFreq: 200, lsGain: -2,
    pkFreq: 2500, pkGain:  3,
    hsFreq: 6000, hsGain:  1,
    saturation: 0,
    ringMod: 0,
    // ▼ エコー（遅延して再生される問題）解消: 0.18 → 0.05
    reverbMix: 0.05,
  },

  ninja: {
    label: '忍者',
    description: '低めで落ち着いたクールな声',
    // ▼ -2半音（わずかに低い、判別しやすい声）
    pitchRatio: 0.891,
    // ▼ HPFで低域ノイズ除去、EQは控えめ
    hpFreq: 150,
    lsFreq: 200, lsGain: -2,
    pkFreq: 1200, pkGain: -2,
    hsFreq: 5000, hsGain: -3,
    // ▼ サチュレーション大幅削減: 0.55→0.18（常時ノイズの主原因）
    saturation: 0.18,
    // ▼ リングモジュレーター廃止: 無発声時の常時ノイズの直接原因
    ringMod: 0,
    reverbMix: 0.03,
  },

  gunshi: {
    label: '軍師',
    description: '穏やかで知的な中低音',
    // ▼ -2半音（以前-3は籠りすぎ）
    pitchRatio: 0.891,
    hpFreq: 120,
    lsFreq: 200, lsGain:  2,
    // ▼ pkGain 6→3dB, Q拡大: 高ゲイン狭帯域ピークがビー音の原因
    pkFreq: 800, pkGain:  3,
    hsFreq: 5000, hsGain: -1,
    saturation: 0.05,
    ringMod: 0,
    // ▼ エコー解消: 0.14 → 0.06
    reverbMix: 0.06,
  },
};

export class VoiceChanger {
  // externalAudioContext: iOS では必ずユーザージェスチャーの同期部分で
  // new AudioContext() + resume() を実行してから渡す必要がある
  constructor(externalAudioContext = null) {
    this._externalAudioContext = externalAudioContext;
    this.audioContext    = null;
    this.sourceNode      = null;
    this.pitchNode       = null;
    // EQ フィルター（4段）
    this.hpFilter        = null; // ハイパスフィルター
    this.lsFilter        = null; // ローシェルフ
    this.pkFilter        = null; // ピークEQ
    this.hsFilter        = null; // ハイシェルフ
    this.saturationNode  = null; // ソフトクリッピング（WaveShaper）
    this.ringModOsc      = null;
    this.ringModGain     = null;
    this.dryGain         = null;
    this.reverbNode      = null;
    this.reverbGain      = null;
    this.compressor      = null;
    this.speakerGain     = null;  // モニタリング用
    this.destinationNode = null;
    this.stream          = null;
    this.outputStream    = null;
    this.currentPreset   = 'none';
  }

  async init(stream) {
    this.stream = stream;

    // iOS: 外部から渡された AudioContext を使う（ユーザージェスチャー同期で作成済み）
    if (this._externalAudioContext) {
      this.audioContext = this._externalAudioContext;
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
    } else {
      this.audioContext = new AudioContext({ sampleRate: 48000 });
    }

    // AudioWorklet（位相ボコーダー）を登録
    await this.audioContext.audioWorklet.addModule('/js/worklets/pitch-shifter.js');

    const ctx = this.audioContext;

    // ノード生成
    this.sourceNode     = ctx.createMediaStreamSource(stream);
    this.pitchNode      = new AudioWorkletNode(ctx, 'pitch-shifter');

    // 4段 EQ フィルター
    this.hpFilter = ctx.createBiquadFilter();
    this.hpFilter.type = 'highpass';
    this.hpFilter.Q.value = 0.7;

    this.lsFilter = ctx.createBiquadFilter();
    this.lsFilter.type = 'lowshelf';

    this.pkFilter = ctx.createBiquadFilter();
    this.pkFilter.type = 'peaking';
    // Q=0.6（広帯域）: 狭いQで高ゲインにするとビー音・ホーミングが出やすい
    this.pkFilter.Q.value = 0.6;

    this.hsFilter = ctx.createBiquadFilter();
    this.hsFilter.type = 'highshelf';

    // サチュレーション（ソフトクリッピング WaveShaper）
    this.saturationNode = ctx.createWaveShaper();
    this.saturationNode.oversample = '4x';

    // リングモジュレーター
    this.ringModOsc  = ctx.createOscillator();
    this.ringModGain = ctx.createGain();
    this.ringModOsc.start();

    // Dry/Wet 分岐
    this.dryGain   = ctx.createGain();
    this.reverbNode = ctx.createConvolver();
    // 短め・早い減衰のリバーブ（1.8秒→0.6秒、decay強化）
    // 長いリバーブテールが「エコー感」「声が2度聞こえる」の原因だった
    this.reverbNode.buffer = this._createImpulseResponse(ctx, 0.6, 0.9);
    this.reverbGain = ctx.createGain();

    // コンプレッサー（音量均一化）
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -20;
    this.compressor.knee.value      = 15;
    this.compressor.ratio.value     = 5;
    this.compressor.attack.value    = 0.005;
    this.compressor.release.value   = 0.15;

    // 出力先
    this.destinationNode = ctx.createMediaStreamDestination();

    // モニタリング用（テスト再生時にスピーカーから聞こえるようにする）
    this.speakerGain = ctx.createGain();
    this.speakerGain.gain.value = 0;
    this.speakerGain.connect(ctx.destination);

    // iOS バックグラウンド対策：無音オシレーターを常時起動
    const keepAliveOsc  = ctx.createOscillator();
    const keepAliveGain = ctx.createGain();
    keepAliveGain.gain.value = 0;
    keepAliveOsc.connect(keepAliveGain);
    keepAliveGain.connect(ctx.destination);
    keepAliveOsc.start();

    // 初期グラフ構築
    this._buildGraph('none');

    this.outputStream = this.destinationNode.stream;
    return this.outputStream;
  }

  setPreset(presetKey) {
    if (!VOICE_PRESETS[presetKey]) return;
    this.currentPreset = presetKey;
    this._buildGraph(presetKey);
  }

  _buildGraph(presetKey) {
    const preset = VOICE_PRESETS[presetKey];
    const ctx    = this.audioContext;
    if (!ctx) return;

    // 既存の接続を解除
    try {
      this.sourceNode.disconnect();
      this.pitchNode.disconnect();
      this.hpFilter.disconnect();
      this.lsFilter.disconnect();
      this.pkFilter.disconnect();
      this.hsFilter.disconnect();
      this.saturationNode.disconnect();
      this.ringModOsc.disconnect();
      this.ringModGain.disconnect();
      this.dryGain.disconnect();
      this.reverbNode.disconnect();
      this.reverbGain.disconnect();
      this.compressor.disconnect();
    } catch {}

    // ── ピッチ設定 ──
    this.pitchNode.parameters.get('pitchRatio').value = preset.pitchRatio;

    // ── ハイパスフィルター ──
    if (preset.hpFreq) {
      this.hpFilter.frequency.value = preset.hpFreq;
    }

    // ── ローシェルフ ──
    this.lsFilter.frequency.value = preset.lsFreq ?? 200;
    this.lsFilter.gain.value      = preset.lsGain ?? 0;

    // ── ピークEQ ──
    this.pkFilter.frequency.value = preset.pkFreq ?? 1000;
    this.pkFilter.gain.value      = preset.pkGain ?? 0;

    // ── ハイシェルフ ──
    this.hsFilter.frequency.value = preset.hsFreq ?? 5000;
    this.hsFilter.gain.value      = preset.hsGain ?? 0;

    // ── サチュレーション曲線 ──
    this.saturationNode.curve = this._createSatCurve(preset.saturation ?? 0);

    // ── リングモジュレーター ──
    this.ringModOsc.frequency.value = preset.ringMod ?? 0;
    this.ringModGain.gain.value     = preset.ringMod > 0 ? 1.0 : 0;

    // ── Dry/Wet ──
    this.dryGain.gain.value   = 1 - (preset.reverbMix ?? 0);
    this.reverbGain.gain.value = preset.reverbMix ?? 0;

    // ── グラフ接続 ──
    // source → pitch → [HP] → LS → PK → HS → saturation → [ringMod] → dry/wet → comp → dest
    this.sourceNode.connect(this.pitchNode);

    // EQ チェーン（直列接続）
    if (preset.hpFreq) {
      this.pitchNode.connect(this.hpFilter);
      this.hpFilter.connect(this.lsFilter);
    } else {
      this.pitchNode.connect(this.lsFilter);
    }
    this.lsFilter.connect(this.pkFilter);
    this.pkFilter.connect(this.hsFilter);
    this.hsFilter.connect(this.saturationNode);

    // リングモジュレーター
    let afterSat = this.saturationNode;
    if (preset.ringMod > 0) {
      const ringInput = this.audioContext.createGain();
      this.saturationNode.connect(ringInput);
      this.ringModOsc.connect(this.ringModGain);
      this.ringModGain.connect(ringInput.gain);
      afterSat = ringInput;
    }

    // Dry / Wet (リバーブ)
    afterSat.connect(this.dryGain);
    this.dryGain.connect(this.compressor);

    if (preset.reverbMix > 0) {
      afterSat.connect(this.reverbNode);
      this.reverbNode.connect(this.reverbGain);
      this.reverbGain.connect(this.compressor);
    }

    this.compressor.connect(this.destinationNode);
    this.compressor.connect(this.speakerGain);
  }

  // ソフトクリッピング（アークタンジェント型サチュレーション）
  // amount=0: 線形（歪みなし）  amount=1: ヘビーサチュレーション
  _createSatCurve(amount) {
    const n    = 512;
    const curve = new Float32Array(n);
    if (amount <= 0.001) {
      // 線形パススルー
      for (let i = 0; i < n; i++) curve[i] = (i * 2) / n - 1;
      return curve;
    }
    const drive = 1 + amount * 20; // 1〜21
    for (let i = 0; i < n; i++) {
      const x    = (i * 2) / n - 1; // -1 〜 1
      curve[i]   = (2 / Math.PI) * Math.atan(x * drive);
    }
    return curve;
  }

  // インパルス応答を生成（エコーバックなしの自然なリバーブ）
  _createImpulseResponse(ctx, duration, decay) {
    const sr     = ctx.sampleRate;
    const len    = Math.round(sr * duration);
    const buf    = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // モニタリング ON/OFF（テスト再生：AudioContext.destination へ直接出力）
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
    this.sourceNode?.disconnect();
    this.audioContext?.close();
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
