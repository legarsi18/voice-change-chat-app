// グラニュラー合成によるリアルタイムピッチシフター
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitchRatio', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0 }];
  }

  constructor() {
    super();
    this.bufferSize = 4096;
    this.grainSize = 512;
    this.overlap = 0.5;

    this.inputBuffer = new Float32Array(this.bufferSize);
    this.outputBuffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.readPos = 0.0;
    this.grainPhase = 0.0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const pitchRatio = parameters.pitchRatio[0] ?? 1.0;
    const grainStep = this.grainSize * (1 - this.overlap);

    for (let i = 0; i < input.length; i++) {
      // 入力をリングバッファに書き込む
      this.inputBuffer[this.writePos % this.bufferSize] = input[i];
      this.writePos++;

      // ピッチ比に応じた位置から読み出す
      const readIdx = Math.floor(this.readPos) % this.bufferSize;
      const nextIdx = (readIdx + 1) % this.bufferSize;
      const frac = this.readPos - Math.floor(this.readPos);

      // 線形補間
      const sample = this.inputBuffer[readIdx] * (1 - frac) + this.inputBuffer[nextIdx] * frac;

      // ハン窓でグレインをエンベロープ
      const windowPos = (this.grainPhase % this.grainSize) / this.grainSize;
      const window = 0.5 * (1 - Math.cos(2 * Math.PI * windowPos));

      output[i] = sample * window;

      this.readPos += pitchRatio;
      this.grainPhase++;

      // 読み書きポジションがずれすぎたらリセット
      const lag = this.writePos - this.readPos;
      if (lag > this.bufferSize - this.grainSize || lag < this.grainSize) {
        this.readPos = this.writePos - this.grainSize * 2;
        this.grainPhase = 0;
      }
    }

    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
