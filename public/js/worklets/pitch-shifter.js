// 位相ボコーダー (Phase Vocoder) によるリアルタイムピッチシフター
//
// 【修正済みバグ】
// バグ①: hsAccum なしで Hs=round(Ha*P) を使うと長時間でドリフトが蓄積し
//         fracRead が outWritePos に追いつく → 声のコピー・ゴーストノイズ
//   修正: hsAccum で小数部を持ち越し、合計書き込みサンプル数が fracRead と一致するよう調整
//
// バグ②: pitchRatio < 1 のとき同じ整数位置を 2 回読んでしまう
//         1 回目: outBuf[ri0] をゼロクリア → 2 回目: 0 を読む → 定期的ゼロサンプル → ビー音
//   修正: lastReadInt を追跡し、整数位置が進んだときだけクリアする
//
// バグ③: synthPhaseAccum が無限に増大し float32 精度が劣化
//         長時間使用で位相誤差が蓄積 → ビー音・ハム音
//   修正: 毎フレーム [0, 2π) に正規化

const TWO_PI = 2 * Math.PI;

// Cooley-Tukey FFT（インプレース、基数2）
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
      { name: 'pitchRatio', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
    ];
  }

  constructor() {
    super();
    this.N  = 1024; // FFT サイズ（レイテンシ ≈ 21ms@48kHz）
    this.Ha = 128;  // 分析ホップ（8× オーバーラップ）

    // Hann 窓
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.win[i] = 0.5 * (1 - Math.cos(TWO_PI * i / this.N));
    }

    // OLA 正規化係数（合成ホップ Ha のとき）
    {
      let sum = 0;
      const ctr = this.N >> 1;
      for (let m = -this.N; m <= this.N; m += this.Ha) {
        const idx = ctr - m;
        if (idx >= 0 && idx < this.N) sum += this.win[idx] ** 2;
      }
      this.winNormBase = 1 / Math.max(sum, 1e-10);
    }

    // 入力循環バッファ
    this.inBuf = new Float32Array(this.N * 2);
    this.inWritePos = 0;
    this.sampleCount = 0;

    // 位相ボコーダー状態
    const bins = (this.N >> 1) + 1;
    this.lastInputPhase  = new Float32Array(bins);
    this.synthPhaseAccum = new Float32Array(bins);
    this.expectedAdv     = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      this.expectedAdv[k] = TWO_PI * k * this.Ha / this.N;
    }

    // FFT 作業バッファ（process() 内でアロケートしない）
    this.fftRe = new Float32Array(this.N);
    this.fftIm = new Float32Array(this.N);
    this.outRe = new Float32Array(this.N);
    this.outIm = new Float32Array(this.N);

    // OLA 出力リングバッファ
    this.outLen      = this.N * 32;
    this.outBuf      = new Float32Array(this.outLen);
    this.outWritePos = this.N; // プリディレイ = N サンプル ≈ 21ms
    this.fracRead    = 0;

    // ── バグ① 修正: hsAccum で Hs のドリフトを防ぐ ──
    // Hs = round(Ha*P) を使うと長時間で fracRead と outWritePos がずれる
    // hsAccum に小数部を持ち越すことで累計書き込みサンプル数を正確に保つ
    this.hsAccum = 0;

    // ── バグ② 修正: lastReadIntPos で安全なクリアを管理 ──
    // pitchRatio < 1 のとき同じ整数位置を複数回読むが、
    // 整数位置が変わったときだけクリアすることで二度読みを安全に処理
    this.lastReadIntPos = 0;
  }

  _wrap(p) {
    p = p % TWO_PI;
    if (p >  Math.PI) p -= TWO_PI;
    if (p < -Math.PI) p += TWO_PI;
    return p;
  }

  _processFrame(pitchRatio) {
    const N  = this.N;
    const Ha = this.Ha;
    const bins = (N >> 1) + 1;

    // ── バグ① 修正: hsAccum で小数部を持ち越す ──
    // 例: pitchRatio=1.189, Ha=128 → Ha*P=152.192
    //   round なら Hs=152 → 0.192 ずつ誤差蓄積
    //   hsAccum なら余り 0.192 を次フレームへ → 累計誤差ゼロ
    this.hsAccum += Ha * pitchRatio;
    const Hs = Math.max(1, Math.floor(this.hsAccum));
    this.hsAccum -= Hs; // 小数部を次フレームへ持ち越す

    // Hann 窓をかけた入力フレームを FFT バッファへコピー
    for (let i = 0; i < N; i++) {
      const idx = (this.inWritePos - N + i + this.inBuf.length) % this.inBuf.length;
      this.fftRe[i] = this.inBuf[idx] * this.win[i];
      this.fftIm[i] = 0;
    }

    fft(this.fftRe, this.fftIm, N);

    // 位相ボコーダー: 瞬時周波数 → 合成位相
    for (let k = 0; k < bins; k++) {
      const mag   = Math.sqrt(this.fftRe[k] ** 2 + this.fftIm[k] ** 2);
      const phase = Math.atan2(this.fftIm[k], this.fftRe[k]);
      const diff  = this._wrap(phase - this.lastInputPhase[k] - this.expectedAdv[k]);
      this.lastInputPhase[k] = phase;

      // 合成位相を Hs/Ha 倍スケールで蓄積
      this.synthPhaseAccum[k] += (Hs / Ha) * (this.expectedAdv[k] + diff);

      // ── バグ③ 修正: synthPhaseAccum を [0, 2π) に正規化 ──
      // 無限増大すると float32 の精度が失われビー音・ハム音が発生する
      this.synthPhaseAccum[k] = ((this.synthPhaseAccum[k] % TWO_PI) + TWO_PI) % TWO_PI;

      this.outRe[k] = mag * Math.cos(this.synthPhaseAccum[k]);
      this.outIm[k] = mag * Math.sin(this.synthPhaseAccum[k]);
    }

    // 負周波数ミラーリング
    for (let k = 1; k < N >> 1; k++) {
      this.outRe[N - k] =  this.outRe[k];
      this.outIm[N - k] = -this.outIm[k];
    }
    this.outRe[0]      = this.fftRe[0]; this.outIm[0] = 0;
    this.outRe[N >> 1] = Math.abs(this.fftRe[N >> 1]); this.outIm[N >> 1] = 0;

    ifft(this.outRe, this.outIm, N);

    // OLA（オーバーラップ加算）
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

    const pitchRatio = parameters.pitchRatio[0] ?? 1.0;

    for (let i = 0; i < input.length; i++) {
      // 入力書き込み
      this.inBuf[this.inWritePos] = input[i];
      this.inWritePos = (this.inWritePos + 1) % this.inBuf.length;

      // Ha サンプルごとにフレーム処理
      if (++this.sampleCount >= this.Ha) {
        this.sampleCount = 0;
        this._processFrame(pitchRatio);
      }

      // 出力読み出し（線形補間）
      const readInt = Math.floor(this.fracRead);
      const ri0 = readInt % this.outLen;
      const ri1 = (ri0 + 1) % this.outLen;
      const fr  = this.fracRead - readInt;
      output[i] = this.outBuf[ri0] * (1 - fr) + this.outBuf[ri1] * fr;

      // ── バグ② 修正: 整数位置が進んだときだけクリア ──
      // pitchRatio < 1: 同じ ri0 を複数回読む → 1 回目のクリアで 0 になるのを防ぐ
      // pitchRatio > 1: 飛び越えた位置もクリアする
      const newIntPos = readInt % this.outLen;
      while (this.lastReadIntPos !== newIntPos) {
        this.outBuf[this.lastReadIntPos] = 0;
        this.lastReadIntPos = (this.lastReadIntPos + 1) % this.outLen;
      }

      // 読み取り位置を進める（pitchRatio 倍速で再サンプリング）
      this.fracRead += pitchRatio;
      if (this.fracRead >= this.outLen) this.fracRead -= this.outLen;
    }

    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
