// PSOLA (Pitch Synchronous Overlap-Add) + Formant Shift
//
// 【なぜ PSOLA か】
//   位相ボコーダー（PV）は FFT ビン間の位相非整合（ムジカルノイズ）が避けられず
//   「水っぽい・金属的」な詐欺音声風の音になる。
//   PSOLA はピッチ周期単位で波形そのものを切り出して OLA するため：
//   ・位相累積エラーが発生しない
//   ・トランジェント（子音）が自然に保たれる
//   ・倍音の位相が元の波形と一致する
//   → 人間音声の自然さが大幅に向上する。
//
// 【アーキテクチャ】
//   1. 自己相関ピッチ検出 (毎 HOP_DETECT サンプル)
//   2. ピッチ周期同期 OLA (PSOLA) でピッチシフト
//   3. 各フレームに FFT スペクトル包絡リマップ (フォルマントシフト)
//   4. 出力バッファ管理は旧 PV と同方式 (fracRead + lastReadInt)
//
// 【パラメーター】
//   pitchRatio   : 基本周波数倍率 (0.5〜2.0)
//   formantRatio : フォルマント（声道）倍率 (0.5〜2.0)

const TWO_PI = 2 * Math.PI;

// ─── FFT (Cooley-Tukey, in-place) ───
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

// ─── PSOLA プロセッサー ───
class PSOLAProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchRatio',   defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
      { name: 'formantRatio', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
    ];
  }

  constructor() {
    super();

    // ─ 入力リングバッファ (8192 サンプル) ─
    this.IN_LEN = 8192;
    this.inBuf  = new Float32Array(this.IN_LEN);
    this.inWrite = 0;

    // ─ ピッチ検出 ─
    this.HOP_DETECT   = 256;          // 検出間隔
    this.detectCount  = 0;
    this.pitchPeriod  = 240;          // 初期値 ~200Hz (@48kHz)
    this.pitchHistory = new Float32Array(8).fill(240);
    this.pitchHistIdx = 0;
    this.pitchLocked  = false;        // 無音時フラグ

    // ─ PSOLA 解析フェーズ ─
    this.analysisPhase = 0;   // 次フレームまでのサンプル数
    this.hsAccum       = 0;   // 合成ホップの端数蓄積

    // ─ 出力リングバッファ ─
    this.OUT_LEN     = 32768;
    this.outBuf      = new Float32Array(this.OUT_LEN);
    // outWrite を fracRead より十分先に置く（初期レイテンシー = 2048 サンプル ≈ 43ms）
    this.outWrite    = 2048;
    this.fracRead    = 0;
    this.lastReadInt = 0;

    // ─ FFT バッファ（各 PSOLA フレームのフォルマントシフト用）─
    this.FFT_N     = 1024;
    this.fftRe     = new Float32Array(this.FFT_N);
    this.fftIm     = new Float32Array(this.FFT_N);
    this.magnitudes = new Float32Array((this.FFT_N >> 1) + 1);
  }

  // ─── 自己相関ピッチ検出 ───────────────────────────────────
  // 戻り値: ピッチ周期 (サンプル数)、無音なら 0
  _detectPitch() {
    // 自己相関を小窓で計算
    const N      = 1024;   // 解析窓
    const minLag = 40;     // ~1200Hz
    const maxLag = 600;    // ~80Hz
    const base   = this.inWrite;

    // 信号パワー
    let power = 0;
    for (let i = 0; i < N; i++) {
      const v = this.inBuf[(base - N + i + this.IN_LEN) % this.IN_LEN];
      power += v * v;
    }
    if (power < 0.0005) return 0; // 無音 → 検出しない

    const M = N - maxLag; // 比較サンプル数
    let bestLag  = this.pitchPeriod | 0;
    let bestCorr = -Infinity;

    for (let tau = minLag; tau <= maxLag; tau += 2) {
      let corr = 0;
      for (let i = 0; i < M; i++) {
        const a = this.inBuf[(base - N + i          + this.IN_LEN) % this.IN_LEN];
        const b = this.inBuf[(base - N + i + tau    + this.IN_LEN) % this.IN_LEN];
        corr += a * b;
      }
      if (corr > bestCorr) { bestCorr = corr; bestLag = tau; }
    }

    // 信頼度: 相関係数 (0〜1)
    const confidence = bestCorr / (power * M / N + 1e-10);
    return confidence > 0.20 ? bestLag : 0;
  }

  // ─── PSOLA フレーム処理 ────────────────────────────────────
  // ・入力バッファからピッチ周期単位で波形窓を切り出す
  // ・FFT → フォルマントシフト → IFFT
  // ・Hann OLA で出力バッファに積み上げる
  _processFrame(pitchRatio, formantRatio) {
    const T  = this.pitchPeriod; // 現在のピッチ周期
    // 窓サイズ = 2 × T（50% オーバーラップで完全再構成）、FFT_N でクランプ
    const W  = Math.min(Math.floor(T * 2), this.FFT_N);
    const WH = W >> 1;

    // 1. ピッチ周期中心で波形を切り出し、Hann 窓を掛ける
    const centerIdx = (this.inWrite - WH + this.IN_LEN) % this.IN_LEN;
    for (let i = 0; i < this.FFT_N; i++) {
      if (i < W) {
        const idx = (centerIdx + i) % this.IN_LEN;
        const w   = 0.5 * (1 - Math.cos(TWO_PI * i / W));
        this.fftRe[i] = this.inBuf[idx] * w;
      } else {
        this.fftRe[i] = 0;
      }
      this.fftIm[i] = 0;
    }

    // 2. FFT
    fft(this.fftRe, this.fftIm, this.FFT_N);

    // 3. フォルマントシフト（スペクトル包絡リマップ）
    //    出力ビン k の magnitude ← 入力ビン k/formantRatio の magnitude
    //    位相は FFT の元位相をそのまま使う（PV のような位相蓄積なし = 自然な音）
    const bins = (this.FFT_N >> 1) + 1;
    if (Math.abs(formantRatio - 1.0) > 0.01) {
      for (let k = 0; k < bins; k++) {
        this.magnitudes[k] = Math.sqrt(this.fftRe[k] ** 2 + this.fftIm[k] ** 2);
      }
      for (let k = 0; k < bins; k++) {
        const srcBin = k / formantRatio;
        const srcL   = Math.floor(srcBin);
        const srcH   = Math.min(srcL + 1, bins - 1);
        const frac   = srcBin - srcL;
        const mag    = srcL < bins
          ? this.magnitudes[srcL] * (1 - frac) + this.magnitudes[srcH] * frac
          : 0;
        const phase = Math.atan2(this.fftIm[k], this.fftRe[k]);
        this.fftRe[k] = mag * Math.cos(phase);
        this.fftIm[k] = mag * Math.sin(phase);
      }
      // 負周波数ミラー
      for (let k = 1; k < this.FFT_N >> 1; k++) {
        this.fftRe[this.FFT_N - k] =  this.fftRe[k];
        this.fftIm[this.FFT_N - k] = -this.fftIm[k];
      }
      this.fftRe[0]            = this.magnitudes[0]; this.fftIm[0] = 0;
      this.fftRe[this.FFT_N >> 1] = Math.abs(this.magnitudes[this.FFT_N >> 1]); this.fftIm[this.FFT_N >> 1] = 0;
    }

    // 4. IFFT → 時間ドメイン波形
    ifft(this.fftRe, this.fftIm, this.FFT_N);

    // 5. 合成ホップ Hs を計算（入力ピッチ周期 × pitchRatio）
    //    hsAccum で端数を追跡してドリフト防止
    this.hsAccum += T * pitchRatio;
    const Hs = Math.max(1, Math.round(this.hsAccum));
    this.hsAccum -= Hs;

    // 6. OLA：出力バッファに加算
    //    Hann 50% オーバーラップ → 正規化係数 = 1.0（完全再構成）
    //    ただし Hs ≠ W/2 のとき若干ズレるため (W/2)/Hs で補正
    const norm = (W * 0.5) / Math.max(Hs, 1);
    for (let i = 0; i < W; i++) {
      const pos = (this.outWrite + i) % this.OUT_LEN;
      this.outBuf[pos] += this.fftRe[i] * norm;
    }
    this.outWrite = (this.outWrite + Hs) % this.OUT_LEN;
  }

  // ─── メイン処理ループ ──────────────────────────────────────
  process(inputs, outputs, parameters) {
    const input  = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const pitchRatio   = parameters.pitchRatio[0]   ?? 1.0;
    const formantRatio = parameters.formantRatio[0]  ?? 1.0;

    for (let i = 0; i < input.length; i++) {
      // 1. 入力をリングバッファに書き込み
      this.inBuf[this.inWrite] = input[i];
      this.inWrite = (this.inWrite + 1) % this.IN_LEN;

      // 2. ピッチ検出（HOP_DETECT サンプルごと）
      if (++this.detectCount >= this.HOP_DETECT) {
        this.detectCount = 0;
        const period = this._detectPitch();
        if (period > 0) {
          // 直近 8 フレームの中央値でスムーシング（外れ値に強い）
          this.pitchHistory[this.pitchHistIdx % 8] = period;
          this.pitchHistIdx++;
          // 中央値
          const sorted = Array.from(this.pitchHistory).sort((a, b) => a - b);
          this.pitchPeriod = sorted[4]; // median of 8
          this.pitchLocked = true;
        }
        // 無音の場合は前回値を維持
      }

      // 3. PSOLA フレームトリガー（ピッチ周期ごと）
      if (++this.analysisPhase >= this.pitchPeriod) {
        this.analysisPhase -= Math.floor(this.pitchPeriod);
        this._processFrame(pitchRatio, formantRatio);
      }

      // 4. 出力読み出し（補間あり）
      const readInt = Math.floor(this.fracRead);
      const ri0     = readInt % this.OUT_LEN;
      const ri1     = (ri0 + 1) % this.OUT_LEN;
      const fr      = this.fracRead - readInt;
      output[i] = this.outBuf[ri0] * (1 - fr) + this.outBuf[ri1] * fr;

      // 5. 読み済みバッファをクリア（旧 PV の Bug② 修正と同方式）
      const newInt = Math.floor(this.fracRead + pitchRatio) % this.OUT_LEN;
      while (this.lastReadInt !== newInt) {
        this.outBuf[this.lastReadInt] = 0;
        this.lastReadInt = (this.lastReadInt + 1) % this.OUT_LEN;
      }

      // 6. fracRead を pitchRatio 分進める（pitchRatio < 1: ゆっくり読む = 低音）
      this.fracRead += pitchRatio;
      if (this.fracRead >= this.OUT_LEN) this.fracRead -= this.OUT_LEN;
    }

    return true;
  }
}

registerProcessor('pitch-shifter', PSOLAProcessor);
