// ボイスチェンジャー
// 位相ボコーダー（AudioWorklet）+ 軽量 EQ
//
// 【設計方針】
//   • ピッチ変化は最小限（±1〜4 半音）：大きなシフトほどロボット感が出る
//   • EQ ゲインは ±3dB 以内：それ以上はこもり感・ビー音の原因になる
//   • リバーブは使用しない：声のコピー感・エコーの直接原因
//   • サチュレーション・リングモジュレーターは使用しない：ノイズ源
//
// 【プリセット一覧】
//   none    : エフェクトなし（パススルー）
//   male1   : 男声 ふつう  (-2 半音)
//   male2   : 男声 低め   (-3 半音)
//   female1 : 女声 ふつう  (+2 半音)
//   female2 : 女声 高め   (+3 半音)

export const VOICE_PRESETS = {
  none: {
    label: '素の声',
    description: 'エフェクトなし',
    pitchRatio: 1.0,
    hpFreq: null,
    lsFreq: 200, lsGain: 0,
    pkFreq: null, pkGain: 0,
    hsFreq: 5000, hsGain: 0,
  },

  male1: {
    label: '男声 ふつう',
    description: '少し低めの男性の声',
    pitchRatio: 0.891,   // -2 半音: 2^(-2/12)
    hpFreq: null,
    lsFreq: 250, lsGain:  2,   // わずかな低域の温かみ
    pkFreq: 600, pkGain:  2,   // 胸声帯域をほんのり強調
    hsFreq: 5000, hsGain: -1,  // 高域を少しだけ落ち着かせる
  },

  male2: {
    label: '男声 低め',
    description: '深みのある男性の声',
    pitchRatio: 0.840,   // -3 半音: 2^(-3/12)
    hpFreq: null,
    lsFreq: 250, lsGain:  3,   // 低域の重みを追加
    pkFreq: 500, pkGain:  2,
    hsFreq: 5000, hsGain: -2,
  },

  female1: {
    label: '女声 ふつう',
    description: '自然な高さの女性の声',
    pitchRatio: 1.122,   // +2 半音: 2^(2/12)
    hpFreq: 150,         // 低域のもこもこ感を除去
    lsFreq: 200, lsGain: -1,
    pkFreq: 2500, pkGain:  2,  // 女声の明るさ・通りを少し強調
    hsFreq: 6000, hsGain:  1,
  },

  female2: {
    label: '女声 高め',
    description: '少し高めの女性の声',
    pitchRatio: 1.189,   // +3 半音: 2^(3/12)
    hpFreq: 180,
    lsFreq: 200, lsGain: -2,
    pkFreq: 3000, pkGain:  2,
    hsFreq: 6000, hsGain:  1,
  },
};

export class VoiceChanger {
  // externalAudioContext: iOS ではユーザージェスチャー内で
  // new AudioContext() + resume() を同期実行して渡す必要がある
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

    // AudioWorklet（位相ボコーダー）登録
    await ctx.audioWorklet.addModule('/js/worklets/pitch-shifter.js');

    // ノード生成
    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.pitchNode  = new AudioWorkletNode(ctx, 'pitch-shifter');

    // EQ（4 段、軽量設計）
    this.hpFilter = ctx.createBiquadFilter();
    this.hpFilter.type    = 'highpass';
    this.hpFilter.Q.value = 0.7;

    this.lsFilter = ctx.createBiquadFilter();
    this.lsFilter.type = 'lowshelf';

    this.pkFilter = ctx.createBiquadFilter();
    this.pkFilter.type    = 'peaking';
    this.pkFilter.Q.value = 0.7;  // 広帯域 → 共振しにくい

    this.hsFilter = ctx.createBiquadFilter();
    this.hsFilter.type = 'highshelf';

    // コンプレッサー（音量均一化・クリッピング防止）
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value      = 12;
    this.compressor.ratio.value     = 4;
    this.compressor.attack.value    = 0.005;
    this.compressor.release.value   = 0.15;

    // 出力
    this.destinationNode = ctx.createMediaStreamDestination();

    // モニタリング用（テスト再生）
    this.speakerGain = ctx.createGain();
    this.speakerGain.gain.value = 0;
    this.speakerGain.connect(ctx.destination);

    // iOS バックグラウンド対策：無音オシレーター
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
    // 未知のキーはデフォルト(none)にフォールバック
    const key = VOICE_PRESETS[presetKey] ? presetKey : 'none';
    this.currentPreset = key;
    this._buildGraph(key);
  }

  _buildGraph(presetKey) {
    const p   = VOICE_PRESETS[presetKey] ?? VOICE_PRESETS.none;
    const ctx = this.audioContext;
    if (!ctx) return;

    // 既存接続を解除
    try {
      this.sourceNode.disconnect();
      this.pitchNode.disconnect();
      this.hpFilter.disconnect();
      this.lsFilter.disconnect();
      this.pkFilter.disconnect();
      this.hsFilter.disconnect();
      this.compressor.disconnect();
    } catch {}

    // ピッチ設定
    this.pitchNode.parameters.get('pitchRatio').value = p.pitchRatio;

    // EQ 設定
    this.lsFilter.frequency.value = p.lsFreq  ?? 200;
    this.lsFilter.gain.value      = p.lsGain  ?? 0;
    this.pkFilter.frequency.value = p.pkFreq  ?? 1000;
    this.pkFilter.gain.value      = p.pkGain  ?? 0;
    this.hsFilter.frequency.value = p.hsFreq  ?? 5000;
    this.hsFilter.gain.value      = p.hsGain  ?? 0;

    // グラフ接続:
    // source → pitch → [HP] → LS → PK → HS → compressor → dest
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
