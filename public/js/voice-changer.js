// ボイスチェンジャー：マイク入力をWeb Audio APIで加工しMediaStreamとして出力する

export const VOICE_PRESETS = {
  none: { label: '素の声', pitchRatio: 1.0, filterFreq: null, reverbMix: 0, ringMod: 0, description: 'エフェクトなし' },
  busho: { label: '武将', pitchRatio: 0.75, filterFreq: 200, reverbMix: 0.2, ringMod: 0, description: '重厚な低音' },
  hime: { label: '姫', pitchRatio: 1.45, filterFreq: 3000, reverbMix: 0.1, ringMod: 0, description: '高音・清楚' },
  ninja: { label: '忍者', pitchRatio: 0.88, filterFreq: null, reverbMix: 0.05, ringMod: 30, description: 'かすれたエコー' },
  gunshi: { label: '軍師', pitchRatio: 0.85, filterFreq: 250, reverbMix: 0.15, ringMod: 0, description: '落ち着いた中低音' },
};

export class VoiceChanger {
  constructor() {
    this.audioContext = null;
    this.sourceNode = null;
    this.pitchNode = null;
    this.filterNode = null;
    this.reverbNode = null;
    this.reverbGain = null;
    this.dryGain = null;
    this.ringModNode = null;
    this.destinationNode = null;
    this.stream = null;
    this.outputStream = null;
    this.currentPreset = 'none';
  }

  async init(stream) {
    this.stream = stream;
    this.audioContext = new AudioContext({ sampleRate: 48000 });

    // AudioWorkletの登録
    await this.audioContext.audioWorklet.addModule('/js/worklets/pitch-shifter.js');

    this.sourceNode = this.audioContext.createMediaStreamSource(stream);
    this.pitchNode = new AudioWorkletNode(this.audioContext, 'pitch-shifter');
    this.filterNode = this.audioContext.createBiquadFilter();
    this.filterNode.type = 'peaking';
    this.filterNode.gain.value = 6;

    // リバーブ用コンボルバー（インパルス応答を生成）
    this.reverbNode = this.audioContext.createConvolver();
    this.reverbNode.buffer = this._createImpulseResponse(1.5, 0.5);
    this.reverbGain = this.audioContext.createGain();
    this.dryGain = this.audioContext.createGain();

    // リングモジュレーター（忍者ボイス用）
    this.ringModOsc = this.audioContext.createOscillator();
    this.ringModGain = this.audioContext.createGain();
    this.ringModOsc.start();

    // コンプレッサー（音量均一化）
    this.compressor = this.audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.destinationNode = this.audioContext.createMediaStreamDestination();

    this._buildGraph('none');

    // iOS バックグラウンド対策：無音オシレーターを常時起動
    const keepAlive = this.audioContext.createOscillator();
    const keepAliveGain = this.audioContext.createGain();
    keepAliveGain.gain.value = 0;
    keepAlive.connect(keepAliveGain);
    keepAliveGain.connect(this.audioContext.destination);
    keepAlive.start();

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

    // 既存の接続をすべて解除
    try {
      this.sourceNode.disconnect();
      this.pitchNode.disconnect();
      this.filterNode.disconnect();
      this.reverbNode.disconnect();
      this.reverbGain.disconnect();
      this.dryGain.disconnect();
      this.ringModOsc.disconnect();
      this.ringModGain.disconnect();
      this.compressor.disconnect();
    } catch {}

    // ピッチ設定
    this.pitchNode.parameters.get('pitchRatio').value = preset.pitchRatio;

    // リングモジュレーター設定
    this.ringModOsc.frequency.value = preset.ringMod || 0;
    this.ringModGain.gain.value = preset.ringMod > 0 ? 1.0 : 0;

    // EQフィルター設定
    if (preset.filterFreq) {
      this.filterNode.frequency.value = preset.filterFreq;
      this.filterNode.gain.value = 5;
    }

    // グラフ再構築
    // source → pitch → (EQ) → dry/wet分岐 → compressor → destination
    this.sourceNode.connect(this.pitchNode);

    let afterPitch = this.pitchNode;

    // リングモジュレーター（忍者ボイス）
    if (preset.ringMod > 0) {
      const ringGain = this.audioContext.createGain();
      this.pitchNode.connect(ringGain);
      this.ringModOsc.connect(this.ringModGain);
      this.ringModGain.connect(ringGain.gain);
      afterPitch = ringGain;
    }

    // EQフィルター
    if (preset.filterFreq) {
      afterPitch.connect(this.filterNode);
      afterPitch = this.filterNode;
    }

    // ドライ信号
    this.dryGain.gain.value = 1 - preset.reverbMix;
    afterPitch.connect(this.dryGain);
    this.dryGain.connect(this.compressor);

    // ウェット（リバーブ）信号
    if (preset.reverbMix > 0) {
      this.reverbGain.gain.value = preset.reverbMix;
      afterPitch.connect(this.reverbNode);
      this.reverbNode.connect(this.reverbGain);
      this.reverbGain.connect(this.compressor);
    }

    this.compressor.connect(this.destinationNode);
  }

  _createImpulseResponse(duration, decay) {
    const sampleRate = this.audioContext.sampleRate;
    const length = sampleRate * duration;
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
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
