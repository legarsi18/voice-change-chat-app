// Phase Vocoder + 位相ロック(Phase Locking) + フォルマントシフト
//
// 【v19 改善: N=4096 (FFTサイズ倍増)】
//
//   N: 2048 → 4096
//   Ha: 256 のまま → オーバーラップ率 8x → 16x に向上
//   周波数分解能: 23.4Hz/bin → 11.7Hz/bin (2倍精細)
//
//   効果:
//   ・ピーク検出の精度向上 → 位相ロックがより正確に機能
//   ・フォルマントシフト時の補間精度が向上
//   ・真の瞬時周波数推定がより正確 → 機械的な音が減少
//   ・高オーバーラップ率 → OLAのスムージング効果が増大
//
//   トレードオフ:
//   ・FFT計算量は約2倍（AudioWorklet専用スレッドなのでUIには影響なし）
//   ・メモリ使用量が約2倍（Float32Array サイズが倍）
//   ・1ホップあたりのレイテンシは変わらず約5.3ms (Ha=256/48kHz)
//
// 【位相ロック (Phase Locking) - v16から継承】
//
//   従来PVの「水っぽい・金属的」音の根本原因:
//   → 同じ倍音に属するビン k, k+1 が独立に位相蓄積するため「垂直位相非整合」が発生。
//
//   位相ロックで解決:
//   1. スペクトルピーク（倍音の中心ビン）を検出
//   2. 各ビンを最近傍ピークに帰属
//   3. ピークビンは従来通り位相追跡（真の瞬時周波数）
//   4. 非ピークビンはピークの位相 + 元の相対位相オフセットを継承
//   → 同じ倍音のビンが位相コヒーレントに → ムジカルノイズ削減
//
// 【バグ修正継承 (旧バージョン)】
//   ①: hsAccum で Hs ドリフト防止
//   ②: lastReadIntPos で安全クリア
//   ③: synthPhaseAccum を [0,2π) 正規化

const TWO_PI = 2 * Math.PI;

// ─── FFT (Cooley-Tukey, in-place) ───────────────────────────
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

// ─── ピッチシフター（位相ロック版）────────────────────────────
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchRatio',   defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
      { name: 'formantRatio', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
    ];
  }

  constructor() {
    super();
    // N=4096: 周波数分解能 11.7Hz/bin, 16x オーバーラップ → 位相推定精度・ムジカルノイズ低減
    this.N  = 4096;
    this.Ha = 256;   // N/16 (16x オーバーラップ)

    // Hann 窓
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.win[i] = 0.5 * (1 - Math.cos(TWO_PI * i / this.N));
    }

    // OLA 正規化係数（Hann 8x オーバーラップ）
    {
      let sum = 0;
      const ctr = this.N >> 1;
      for (let m = -this.N; m <= this.N; m += this.Ha) {
        const idx = ctr - m;
        if (idx >= 0 && idx < this.N) sum += this.win[idx] ** 2;
      }
      this.winNormBase = 1 / Math.max(sum, 1e-10);
    }

    this.inBuf      = new Float32Array(this.N * 2);
    this.inWritePos = 0;
    this.sampleCount = 0;

    const bins = (this.N >> 1) + 1; // 2049 bins

    // ── 位相ボコーダー用 ──
    this.lastInputPhase  = new Float32Array(bins);
    this.synthPhaseAccum = new Float32Array(bins);
    this.expectedAdv     = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      this.expectedAdv[k] = TWO_PI * k * this.Ha / this.N;
    }
    this.magnitudes = new Float32Array(bins);

    // ── 【位相ロック用】追加バッファ ──
    this.trueFreq  = new Float32Array(bins);  // 真の瞬時周波数偏差
    this.peakOf    = new Int32Array(bins);    // 各ビンが帰属するピーク番号
    this.leftPeak  = new Int32Array(bins);    // 左スキャン用ワーク

    // ── FFT バッファ ──
    this.fftRe = new Float32Array(this.N);
    this.fftIm = new Float32Array(this.N);
    this.outRe = new Float32Array(this.N);
    this.outIm = new Float32Array(this.N);

    // ── 出力リングバッファ (N*32 = 131072) ──
    this.outLen      = this.N * 32;
    this.outBuf      = new Float32Array(this.outLen);
    this.outWritePos = this.N;
    this.fracRead    = 0;

    this.hsAccum        = 0;
    this.lastReadIntPos = 0;
  }

  _wrap(p) {
    p = p % TWO_PI;
    if (p >  Math.PI) p -= TWO_PI;
    if (p < -Math.PI) p += TWO_PI;
    return p;
  }

  _processFrame(pitchRatio, formantRatio) {
    const N   = this.N;
    const Ha  = this.Ha;
    const bins = (N >> 1) + 1;

    // ①: hsAccum で Hs ドリフト防止
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

    // ─────────────────────────────────────────────────────────────
    // 【Phase Locking: 5パス処理】
    //
    // Pass 1: 各ビンの magnitude・真の瞬時周波数を計算
    for (let k = 0; k < bins; k++) {
      const re    = this.fftRe[k], im = this.fftIm[k];
      const mag   = Math.sqrt(re * re + im * im);
      const phase = Math.atan2(im, re);
      const diff  = this._wrap(phase - this.lastInputPhase[k] - this.expectedAdv[k]);
      this.lastInputPhase[k] = phase;
      this.trueFreq[k]        = this.expectedAdv[k] + diff;
      this.magnitudes[k]      = mag;
      this.peakOf[k]          = -1; // リセット
    }

    // Pass 2: スペクトルピーク検出（局所最大値）
    //         ピークは自分自身を peakOf[k] = k で表す
    for (let k = 1; k < bins - 1; k++) {
      if (this.magnitudes[k] > this.magnitudes[k - 1] &&
          this.magnitudes[k] >= this.magnitudes[k + 1]) {
        this.peakOf[k] = k;
      }
    }
    // 端点
    if (bins > 1 && this.magnitudes[0] >= this.magnitudes[1])          this.peakOf[0]      = 0;
    if (bins > 1 && this.magnitudes[bins-1] >= this.magnitudes[bins-2]) this.peakOf[bins-1] = bins - 1;

    // Pass 3: 各ビンを最近傍ピークに帰属（O(N) 線形スキャン）
    //   左スキャン: 左側で最後に見たピーク
    {
      let lp = -1;
      for (let k = 0; k < bins; k++) {
        if (this.peakOf[k] === k) lp = k;
        this.leftPeak[k] = lp;
      }
    }
    //   右スキャン: 右側で最後に見たピークと比較して近い方を採用
    {
      let rp = -1;
      for (let k = bins - 1; k >= 0; k--) {
        if (this.peakOf[k] === k) { rp = k; continue; }
        const ll = this.leftPeak[k];
        if (ll < 0 && rp < 0)       { this.peakOf[k] = -1;                                           }
        else if (ll < 0)             { this.peakOf[k] = rp;                                           }
        else if (rp < 0)             { this.peakOf[k] = ll;                                           }
        else this.peakOf[k] = (Math.abs(k - ll) <= Math.abs(k - rp)) ? ll : rp;
      }
    }

    // Pass 4: ピークビンの位相を更新（標準 PV 位相蓄積）
    for (let k = 0; k < bins; k++) {
      if (this.peakOf[k] === k) { // ピーク自身
        this.synthPhaseAccum[k] += (Hs / Ha) * this.trueFreq[k];
        // ③: float 精度劣化防止
        this.synthPhaseAccum[k] = ((this.synthPhaseAccum[k] % TWO_PI) + TWO_PI) % TWO_PI;
      }
    }

    // Pass 5: 非ピークビンの位相をピークにロック
    //   synthPhase[k] = synthPhase[peak] + (inputPhase[k] - inputPhase[peak])
    //   → 同じ倍音グループが位相コヒーレントに動く = ムジカルノイズ削減
    for (let k = 0; k < bins; k++) {
      const pk = this.peakOf[k];
      if (pk < 0 || pk === k) {
        // ピークなし（無音時）か自身がピーク → 個別フォールバック
        if (pk < 0) {
          this.synthPhaseAccum[k] += (Hs / Ha) * this.trueFreq[k];
          this.synthPhaseAccum[k] = ((this.synthPhaseAccum[k] % TWO_PI) + TWO_PI) % TWO_PI;
        }
        continue;
      }
      // 非ピーク: ピークの合成位相 + 入力における相対位相オフセットを継承
      const relPhase = this._wrap(
        Math.atan2(this.fftIm[k], this.fftRe[k]) -
        Math.atan2(this.fftIm[pk], this.fftRe[pk])
      );
      this.synthPhaseAccum[k] = (this.synthPhaseAccum[pk] + relPhase + TWO_PI) % TWO_PI;
    }
    // ─────────────────────────────────────────────────────────────

    // 【フォルマントシフト】
    // 出力ビン k の magnitude = 入力ビン k/formantRatio の magnitude（線形補間）
    // 位相は Phase Locking でトラッキング済みの値を使う
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

    // 【素の声（none）: FFT を完全スキップしてスルー → レイテンシーゼロ・ノイズゼロ】
    if (Math.abs(pitchRatio - 1.0) < 0.001 && Math.abs(formantRatio - 1.0) < 0.001) {
      output.set(input);
      return true;
    }

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

      // ②: 整数位置が進んだときだけクリア（ビー音バグ防止）
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
