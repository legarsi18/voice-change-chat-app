// ボイスチェンジャー
// 位相ボコーダー（ピッチ独立）+ フォルマントシフト（声道独立）+ EQ
//
// 【アニメ・ゲームキャラクター声の設計原則】
//   声のキャラクターは「ピッチ」だけでなく「フォルマント」で決まる。
//   フォルマント = 声道の共鳴周波数 = 声帯の長さ・形で決まる音色の核心。
//
//   formantRatio < 1.0 : 声道が長い（体が大きい/渋い男性）→ 低く響く
//   formantRatio > 1.0 : 声道が短い（体が小さい/アニメ女性）→ 明るく細い
//
// 【プリセット設計】
//   none     : エフェクトなし
//   male1    : 男性 普通    ─ 少し低め、自然な男性キャラ
//   male2    : 男性 クール  ─ 深みのある渋い男性（声道も長く）
//   female1  : 女性 普通    ─ 少し高め、落ち着いたお姉さん系
//   female2  : 女性 アニメ  ─ アニメキャラ風（声道も短くフォルマント高め）

export const VOICE_PRESETS = {
  none: {
    label: '素の声',
    description: 'エフェクトなし',
    pitchRatio:   1.0,
    formantRatio: 1.0,
    hpFreq: null,
    lsFreq: 200, lsGain: 0,
    pkFreq: null, pkGain: 0,
    hsFreq: 5000, hsGain: 0,
  },

  male1: {
    label: '男性 普通',
    description: '少し低めの自然な男性キャラ',
    // ピッチ: -2 半音 → 少し低い
    pitchRatio: 0.891,
    // フォルマント: -8% → 声道が少し長い（やや体格のある男性）
    formantRatio: 0.92,
    hpFreq: null,
    lsFreq: 250, lsGain:  2,   // 低域の温かみ
    pkFreq: 2200, pkGain:  3,  // プレゼンス（声が前に出る）
    hsFreq: 5000, hsGain: -1,
  },

  male2: {
    label: '男性 クール',
    description: '渋くて深みのある男性キャラ',
    // ピッチ: -4 半音 → かなり低い
    pitchRatio: 0.794,
    // フォルマント: -22% → 大柄な声道（ゲームの主人公・渋いキャラ系）
    // ピッチとフォルマントを両方下げることで「別人感」が出る
    formantRatio: 0.78,
    hpFreq: null,
    lsFreq: 200, lsGain:  3,   // 重みのある低域
    pkFreq: 1800, pkGain:  3,  // 中域プレゼンス（低くても聞こえやすく）
    hsFreq: 5000, hsGain: -2,
  },

  female1: {
    label: '女性 普通',
    description: '落ち着いた大人の女性キャラ',
    // ピッチ: +2 半音 → 少し高い
    pitchRatio: 1.122,
    // フォルマント: +12% → 声道が少し短い（女性的な明るさ）
    formantRatio: 1.12,
    hpFreq: 160,
    lsFreq: 200, lsGain: -1,
    pkFreq: 2800, pkGain:  3,  // 透明感・通り
    hsFreq: 6000, hsGain:  1,
  },

  female2: {
    label: '女性 アニメ',
    description: 'アニメキャラクター風の女性の声',
    // ピッチ: +3 半音 → 高い
    pitchRatio: 1.189,
    // フォルマント: +32% → 大幅に短い声道（アニメキャラ特有の「金属的な明るさ」）
    // これがアニメ声の核心。ピッチだけ上げてもアニメっぽくならない。
    formantRatio: 1.32,
    hpFreq: 200,
    lsFreq: 200, lsGain: -3,   // 低域をスッキリ
    pkFreq: 3500, pkGain:  3,  // アニメ声のキャラクター帯域
    hsFreq: 7000, hsGain:  2,  // 空気感・抜け感
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
    this.hsFilter        = null;
    this.compressor      = null;
    this.speakerGain     = null;
    this.destinationNode = null;
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
    this.pkFilter.type    = 'peaking';
    this.pkFilter.Q.value = 0.7;

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

    try {
      this.sourceNode.disconnect();
      this.pitchNode.disconnect();
      this.hpFilter.disconnect();
      this.lsFilter.disconnect();
      this.pkFilter.disconnect();
      this.hsFilter.disconnect();
      this.compressor.disconnect();
    } catch {}

    // ピッチ・フォルマント設定
    this.pitchNode.parameters.get('pitchRatio').value   = p.pitchRatio;
    this.pitchNode.parameters.get('formantRatio').value = p.formantRatio ?? 1.0;

    // EQ 設定
    this.lsFilter.frequency.value = p.lsFreq  ?? 200;
    this.lsFilter.gain.value      = p.lsGain  ?? 0;
    this.pkFilter.frequency.value = p.pkFreq  ?? 1000;
    this.pkFilter.gain.value      = p.pkGain  ?? 0;
    this.hsFilter.frequency.value = p.hsFreq  ?? 5000;
    this.hsFilter.gain.value      = p.hsGain  ?? 0;

    // グラフ接続: source → pitch → [HP] → LS → PK → HS → comp → dest
    this.sourceNode.connect(this.pitchNode);

    if (p.hpFreq) {
      this.hpFilter.frequency.value = p.hpFreq;
      this.pitchNode.connect(this.hpFilter);
      this.hpFilter.connect(this.lsFilter);
    } else {
      this.pitchNode.connect(this.lsFilter);
    }

    this.lsFilter.connect(this.pkFilter);
    this.pkFilter.connect(this.hsFilter);
    this.hsFilter.connect(this.compressor);
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
    this.sourceNode?.disconnect();
    this.audioContext?.close();
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
