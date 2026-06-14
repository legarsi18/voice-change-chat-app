// 位相ボコーダー + フォルマントシフト
//
// 【2パラメーター独立制御】
//   pitchRatio  : 基本周波数（音の高さ）を変える
//   formantRatio: フォルマント（声道共鳴）を独立して変える
//
// これによりアニメ・ゲームキャラクター声の核心を再現できる:
//   アニメ女性 → pitchRatio=1.19, formantRatio=1.35 (声道が短い小柄な声)
//   渋い男性   → pitchRatio=0.84, formantRatio=0.78 (声道が長い大柄な声)
//
// 【フォルマントシフトのしくみ】
//   位相ボコーダーで取得した各ビンの magnitude を formantRatio でリマップする。
//   出力ビン k に「入力ビン k/formantRatio の magnitude」を割り当てることで
//   スペクトル包絡（フォルマント）を独立して上下できる。
//   位相は pitchRatio でトラッキングした値を維持するため両者が独立する。
//
// 【修正済みバグ】(前バージョンから継承)
//   ①: hsAccum で Hs ドリフト防止
//   ②: lastReadIntPos で安全クリア
//   ③: synthPhaseAccum を毎フレーム [0,2π) 正規化

const TWO_PI = 2 * Math.PI;

function fft(re, im, n) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = -TWO_PI / len;
    const wRe  = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe;        im[a] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe; cRe = nRe;
      }
    }
  }
}

function ifft(re, im, n) {
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im, n);
  const s = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= s; im[i] = -im[i] * s; }
}

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchRatio',  defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
      { name: 'formantRatio', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
    ];
  }

  constructor() {
    super();
    this.N  = 1024;
    this.Ha = 128;

    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.win[i] = 0.5 * (1 - Math.cos(TWO_PI * i / this.N));
    }

    {
      let sum = 0;
      const ctr = this.N >> 1;
      for (let m = -this.N; m <= this.N; m += this.Ha) {
        const idx = ctr - m;
        if (idx >= 0 && idx < this.N) sum += this.win[idx] ** 2;
      }
      this.winNormBase = 1 / Math.max(sum, 1e-10);
    }

    this.inBuf = new Float32Array(this.N * 2);
    this.inWritePos = 0;
    this.sampleCount = 0;

    const bins = (this.N >> 1) + 1;
    this.lastInputPhase  = new Float32Array(bins);
    this.synthPhaseAccum = new Float32Array(bins);
    this.expectedAdv     = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      this.expectedAdv[k] = TWO_PI * k * this.Ha / this.N;
    }

    // フォルマントシフト用マグニチュード保存バッファ
    this.magnitudes = new Float32Array(bins);

    this.fftRe = new Float32Array(this.N);
    this.fftIm = new Float32Array(this.N);
    this.outRe = new Float32Array(this.N);
    this.outIm = new Float32Array(this.N);

    this.outLen      = this.N * 32;
    this.outBuf      = new Float32Array(this.outLen);
    this.outWritePos = this.N;
    this.fracRead    = 0;

    this.hsAccum       = 0;
    this.lastReadIntPos = 0;
  }

  _wrap(p) {
    p = p % TWO_PI;
    if (p >  Math.PI) p -= TWO_PI;
    if (p < -Math.PI) p += TWO_PI;
    return p;
  }

  _processFrame(pitchRatio, formantRatio) {
    const N  = this.N;
    const Ha = this.Ha;
    const bins = (N >> 1) + 1;

    // バグ①: hsAccum で Hs ドリフトを防ぐ
    this.hsAccum += Ha * pitchRatio;
    const Hs = Math.max(1, Math.floor(this.hsAccum));
    this.hsAccum -= Hs;

    // Hann 窓 + FFT
    for (let i = 0; i < N; i++) {
      const idx = (this.inWritePos - N + i + this.inBuf.length) % this.inBuf.length;
      this.fftRe[i] = this.inBuf[idx] * this.win[i];
      this.fftIm[i] = 0;
    }
    fft(this.fftRe, this.fftIm, N);

    // 位相ボコーダー: 各ビンの magnitude と位相を計算
    for (let k = 0; k < bins; k++) {
      const mag   = Math.sqrt(this.fftRe[k] ** 2 + this.fftIm[k] ** 2);
      const phase = Math.atan2(this.fftIm[k], this.fftRe[k]);
      const diff  = this._wrap(phase - this.lastInputPhase[k] - this.expectedAdv[k]);
      this.lastInputPhase[k] = phase;

      // pitchRatio に応じた位相蓄積（ピッチシフト）
      this.synthPhaseAccum[k] += (Hs / Ha) * (this.expectedAdv[k] + diff);
      // バグ③: float 精度劣化防止
      this.synthPhaseAccum[k] = ((this.synthPhaseAccum[k] % TWO_PI) + TWO_PI) % TWO_PI;

      // フォルマントシフト用にマグニチュードを保存
      this.magnitudes[k] = mag;
    }

    // 【フォルマントシフト】
    // 出力ビン k の magnitude = 入力ビン k/formantRatio の magnitude
    // formantRatio > 1: スペクトル包絡を上にシフト → 声道が短い（アニメ女性）
    // formantRatio < 1: スペクトル包絡を下にシフト → 声道が長い（渋い男性）
    // 位相は pitchRatio でトラッキングした値を維持 → ピッチとフォルマントが独立
    for (let k = 0; k < bins; k++) {
      let mag;
      if (Math.abs(formantRatio - 1.0) < 0.001) {
        mag = this.magnitudes[k];
      } else {
        const srcBin  = k / formantRatio;
        const srcLow  = Math.floor(srcBin);
        const srcHigh = Math.min(srcLow + 1, bins - 1);
        const frac    = srcBin - srcLow;
        mag = srcLow < bins
          ? this.magnitudes[srcLow] * (1 - frac) + this.magnitudes[srcHigh] * frac
          : 0;
      }
      this.outRe[k] = mag * Math.cos(this.synthPhaseAccum[k]);
      this.outIm[k] = mag * Math.sin(this.synthPhaseAccum[k]);
    }

    // 負周波数ミラー
    for (let k = 1; k < N >> 1; k++) {
      this.outRe[N - k] =  this.outRe[k];
      this.outIm[N - k] = -this.outIm[k];
    }
    this.outRe[0]      = this.fftRe[0]; this.outIm[0] = 0;
    this.outRe[N >> 1] = Math.abs(this.fftRe[N >> 1]); this.outIm[N >> 1] = 0;

    ifft(this.outRe, this.outIm, N);

    const norm = this.winNormBase * (Ha / Hs);
    for (let i = 0; i < N; i++) {
      const pos = (this.outWritePos + i) % this.outLen;
      this.outBuf[pos] += this.outRe[i] * this.win[i] * norm;
    }
    this.outWritePos = (this.outWritePos + Hs) % this.outLen;
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const pitchRatio   = parameters.pitchRatio[0]   ?? 1.0;
    const formantRatio = parameters.formantRatio[0]  ?? 1.0;

    for (let i = 0; i < input.length; i++) {
      this.inBuf[this.inWritePos] = input[i];
      this.inWritePos = (this.inWritePos + 1) % this.inBuf.length;

      if (++this.sampleCount >= this.Ha) {
        this.sampleCount = 0;
        this._processFrame(pitchRatio, formantRatio);
      }

      const readInt = Math.floor(this.fracRead);
      const ri0 = readInt % this.outLen;
      const ri1 = (ri0 + 1) % this.outLen;
      const fr  = this.fracRead - readInt;
      output[i] = this.outBuf[ri0] * (1 - fr) + this.outBuf[ri1] * fr;

      // バグ②: 整数位置が進んだときだけクリア
      const newIntPos = readInt % this.outLen;
      while (this.lastReadIntPos !== newIntPos) {
        this.outBuf[this.lastReadIntPos] = 0;
        this.lastReadIntPos = (this.lastReadIntPos + 1) % this.outLen;
      }

      this.fracRead += pitchRatio;
      if (this.fracRead >= this.outLen) this.fracRead -= this.outLen;
    }

    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
