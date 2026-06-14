// 位相ボコーダー (Phase Vocoder) によるリアルタイムピッチシフター
//
// 【改良点】旧グラニュラー合成からの変更
//   グラニュラー: readPos が負になる / 音が揺れる / ヘリウム感
//   位相ボコーダー: 各周波数ビンの瞬時位相を追跡 → 正確なピッチシフト
//
// アルゴリズム: 時間伸縮 + 再サンプリング
//   1. FFT で周波数ドメインに変換
//   2. 各ビンの真の瞬時周波数を位相差から計算
//   3. 合成ホップ Hs = Ha * pitchRatio で OLA 出力（時間伸縮）
//   4. 出力を pitchRatio 倍速で読み出し（再サンプリングで時間を元に戻す）
//   結果: 時間は変わらず、ピッチだけが pitchRatio 倍になる

const TWO_PI = 2 * Math.PI;

// Cooley-Tukey FFT（インプレース、基数2、時間間引き）
function fft(re, im, n) {
  // ビット反転置換
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // バタフライ演算
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
      { name: 'pitchRatio', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0 },
    ];
  }

  constructor() {
    super();
    this.N  = 2048; // FFT サイズ（周波数解像度とレイテンシのバランス）
    this.Ha = 256;  // 分析ホップ（8倍オーバーラップ）

    // Hann 窓関数
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.win[i] = 0.5 * (1 - Math.cos(TWO_PI * i / this.N));
    }

    // OLA 正規化係数を事前計算（合成ホップ = Ha のケース）
    // = 1 / sum_m(win[center - m*Ha]^2) で窓のオーバーラップゲインを補正
    {
      let sum = 0;
      const ctr = this.N >> 1;
      for (let m = -this.N; m <= this.N; m += this.Ha) {
        const idx = ctr - m;
        if (idx >= 0 && idx < this.N) sum += this.win[idx] ** 2;
      }
      this.winNormBase = 1 / Math.max(sum, 1e-10);
    }

    // 循環入力バッファ（2 * N で余裕を持たせる）
    this.inBuf = new Float32Array(this.N * 2);
    this.inWritePos = 0;
    this.sampleCount = 0;

    // 位相ボコーダー状態
    const bins = (this.N >> 1) + 1;
    this.lastInputPhase  = new Float32Array(bins);
    this.synthPhaseAccum = new Float32Array(bins);

    // 各ビンの Ha あたりの期待位相進行量
    this.expectedAdv = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      this.expectedAdv[k] = TWO_PI * k * this.Ha / this.N;
    }

    // FFT 作業バッファ（process() 内でアロケートしない → GC プレッシャーなし）
    this.fftRe = new Float32Array(this.N);
    this.fftIm = new Float32Array(this.N);
    this.outRe = new Float32Array(this.N);
    this.outIm = new Float32Array(this.N);

    // OLA 出力リングバッファ（max pitchRatio=4 対応 + 余裕）
    this.outLen      = this.N * 32;
    this.outBuf      = new Float32Array(this.outLen);
    this.outWritePos = this.N; // 初期プリディレイ（レイテンシ = N サンプル ≈ 43ms@48kHz）
    this.fracRead    = 0;      // 小数点読み取り位置（再サンプリング用）
  }

  // 位相を [-π, π] に正規化
  _wrap(p) {
    // 効率的なラッピング（whileループより高速）
    p = p % TWO_PI;
    if (p > Math.PI)  p -= TWO_PI;
    if (p < -Math.PI) p += TWO_PI;
    return p;
  }

  _processFrame(pitchRatio) {
    const N  = this.N;
    const Ha = this.Ha;
    // 合成ホップ: pitchRatio 倍にすることで時間伸縮を実現
    const Hs   = Math.max(1, Math.round(Ha * pitchRatio));
    const bins = (N >> 1) + 1;

    // 最新 N サンプルを Hann 窓で切り出し FFT バッファへコピー
    for (let i = 0; i < N; i++) {
      const idx = (this.inWritePos - N + i + this.inBuf.length) % this.inBuf.length;
      this.fftRe[i] = this.inBuf[idx] * this.win[i];
      this.fftIm[i] = 0;
    }

    fft(this.fftRe, this.fftIm, N);

    // 位相ボコーダー処理: 瞬時周波数から合成位相を計算
    for (let k = 0; k < bins; k++) {
      const mag   = Math.sqrt(this.fftRe[k] ** 2 + this.fftIm[k] ** 2);
      const phase = Math.atan2(this.fftIm[k], this.fftRe[k]);

      // 期待位相進行からのズレ（位相アンラッピング）
      const diff     = this._wrap(phase - this.lastInputPhase[k] - this.expectedAdv[k]);
      const trueAdv  = this.expectedAdv[k] + diff; // 真の瞬時周波数（位相/サンプル）

      this.lastInputPhase[k] = phase;

      // 合成位相を Hs/Ha 倍スケールで蓄積（時間伸縮に対応）
      this.synthPhaseAccum[k] += (Hs / Ha) * trueAdv;

      this.outRe[k] = mag * Math.cos(this.synthPhaseAccum[k]);
      this.outIm[k] = mag * Math.sin(this.synthPhaseAccum[k]);
    }

    // 負の周波数ビンをミラーリング（実数信号の復元）
    for (let k = 1; k < N >> 1; k++) {
      this.outRe[N - k] =  this.outRe[k];
      this.outIm[N - k] = -this.outIm[k];
    }
    this.outRe[0]      = this.fftRe[0]; this.outIm[0] = 0;
    this.outRe[N >> 1] = Math.abs(this.fftRe[N >> 1]); this.outIm[N >> 1] = 0;

    ifft(this.outRe, this.outIm, N);

    // 合成ホップ Hs で OLA（オーバーラップ加算）
    // 合成ホップが変わるとオーバーラップ数が変わるため正規化を Ha/Hs でスケール
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
      // 入力サンプルを循環バッファに書き込む
      this.inBuf[this.inWritePos] = input[i];
      this.inWritePos = (this.inWritePos + 1) % this.inBuf.length;

      // Ha サンプルごとに分析フレームを処理
      if (++this.sampleCount >= this.Ha) {
        this.sampleCount = 0;
        this._processFrame(pitchRatio);
      }

      // 出力バッファから線形補間で読み出し（pitchRatio 倍速で再サンプリング）
      // → 時間伸縮（Hs = Ha*P）を打ち消して元の速度に戻す
      const ri0 = Math.floor(this.fracRead) % this.outLen;
      const ri1 = (ri0 + 1) % this.outLen;
      const fr  = this.fracRead - Math.floor(this.fracRead);
      output[i] = this.outBuf[ri0] * (1 - fr) + this.outBuf[ri1] * fr;

      // 読んだサンプルをクリア
      this.outBuf[ri0] = 0;

      // 小数点読み取り位置を pitchRatio 進める
      this.fracRead += pitchRatio;
      if (this.fracRead >= this.outLen) this.fracRead -= this.outLen;
    }

    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
