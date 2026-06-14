// ボイスチェンジャー
// 位相ボコーダー（ピッチ独立）+ フォルマントシフト（声道独立）+ EQ + 息感ノイズ
//
// 【ゲームキャラクター声の設計原則】
//   声のキャラクターは「フォルマント」が8割を決める。
//   フォルマント = 声道の共鳴周波数 = 声帯の長さ・形で決まる音色の核心。
//
//   formantRatio < 1.0 : 声道が長い（体が大きい/重厚な男性）→ 低く響く
//   formantRatio > 1.0 : 声道が短い（体が小さい/女性キャラ）→ 明るく抜ける
//
// 【プリセット設計 - ゲームキャラクターアーキタイプ】
//   none    : エフェクトなし
//   male1   : M-1 重戦士・武人系  ─ ピッチ-4st、フォルマント下げ、200Hz厚み
//   male2   : M-2 少年・軽快系    ─ ピッチ+1st、F2上げ、4kHz明るさ・前に出る声
//   female1 : F-1 ヒロイン・清楚系 ─ ピッチ+3st、F2大幅上げ、2.5kHzキラキラ、息漏れ
//   female2 : F-2 ボーイッシュ・戦士系 ─ ピッチ-1st、F1抑制、200-400Hz芯、中性感
//
// 【EQ設計の考え方】
//   男性重戦士: 150Hz厚み + 2kHzプレゼンス(こもり回避) + 5kHz以上カット(重厚感)
//   少年軽快:  120Hz以下カット(軽さ) + 4kHzブースト(抜け感・フォワード)
//   ヒロイン:  200Hz以下カット(スッキリ) + 2.5kHzシェイプ(きらめき) + 8kHz空気感
//   ボーイッシュ: 300Hzブースト(芯・200-400Hz帯) + 5kHz以上カット(中性感)
//
// 【息感(breathMix)】
//   F-1専用。声道通過後の高域ノイズを微量ミックスして"息漏れ"質感を付加する。
//   breathMix: 0〜0.05程度。0=なし、0.03=ほんのり息漏れ

export const VOICE_PRESETS = {
  none: {
    label: '素の声',
    description: 'エフェクトなし',
    pitchRatio:   1.0,
    formantRatio: 1.0,
    hpFreq: null,
    lsFreq: 200,  lsGain: 0,
    pkFreq: 1000, pkGain: 0,
    hsFreq: 5000, hsGain: 0,
    breathMix: 0,
  },

  male1: {
    label: '男性 重戦士',
    description: '重みと威圧感のある武人系キャラ',
    // ピッチ: -4 半音 → 低くどっしり
    pitchRatio: 0.794,
    // フォルマント: -18% → 体格のある声道（大柄な戦士感）
    // ※あまり極端に下げるとこもる。0.82 が naturalness と character のバランス点
    formantRatio: 0.82,
    hpFreq: null,
    lsFreq: 150,  lsGain:  3,   // 150Hz 厚み・重量感
    pkFreq: 2000, pkGain:  2,   // 2kHz プレゼンス（こもりを防ぎ聴き取りやすく）
    hsFreq: 5000, hsGain: -3,   // 5kHz以上カット → ダーク・重厚
    breathMix: 0,
  },

  male2: {
    label: '男性 少年・軽快',
    description: '明るく前に出る俊敏な少年系キャラ',
    // ピッチ: +1 半音 → やや高い（少年感）
    pitchRatio: 1.059,
    // フォルマント: +10% → F2 上げ（前に出る明るさ・子音の鮮明さ）
    formantRatio: 1.10,
    hpFreq: 120,                 // 120Hz 以下カット（軽さ・重くしない）
    lsFreq: 200,  lsGain: -2,   // 低域スリム
    pkFreq: 4000, pkGain:  3,   // 3〜5kHz ブースト → 抜け感・子音立ち
    hsFreq: 7000, hsGain:  1,   // 7kHz 空気感
    breathMix: 0,
  },

  female1: {
    label: '女性 ヒロイン',
    description: '透明感・清楚さのあるヒロイン系キャラ',
    // ピッチ: +3 半音 → 明るく上品
    pitchRatio: 1.189,
    // フォルマント: +25% → F1 微増＋F2 大幅増（/i/ /e/ の透明感・清潔感）
    formantRatio: 1.25,
    hpFreq: 200,                 // 200Hz 以下カット（スッキリ感）
    lsFreq: 200,  lsGain: -2,   // 低域を締める
    pkFreq: 2500, pkGain:  3,   // 1.5〜3kHz 倍音シェイプ（きらきら感）
    hsFreq: 8000, hsGain:  2,   // 8kHz 空気感・抜け感
    breathMix: 0.03,             // 息漏れ（柔らかさ・ヒロインらしさ）
  },

  female2: {
    label: '女性 ボーイッシュ',
    description: '芯の強い中性的な女性戦士キャラ',
    // ピッチ: -1 半音 → ほぼ変えない（元の声に近い音域で中性感）
    pitchRatio: 0.944,
    // フォルマント: -10% → F1 下げ（胸声感）、F2 中庸（中性感）
    formantRatio: 0.90,
    hpFreq: 120,                 // 120Hz 以下カット
    lsFreq: 300,  lsGain:  2,   // 200〜400Hz コア（芯・存在感）
    pkFreq: 1000, pkGain:  0,   // ミッド フラット
    hsFreq: 5000, hsGain: -2,   // 5kHz以上抑制（中性感・鋭さ排除）
    breathMix: 0,
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
    // 息感ノイズチェーン
    this.breathSrc       = null;
    this.breathHPF       = null;
    this.breathGain      = null;
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
    this.pkFilter.Q.value = 0.8;

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

    // iOS バックグラウンド対策（無音オシレーター）
    const kaOsc  = ctx.createOscillator();
    const kaGain = ctx.createGain();
    kaGain.gain.value = 0;
    kaOsc.connect(kaGain);
    kaGain.connect(ctx.destination);
    kaOsc.start();

    // ─── 息感ノイズチェーン（F-1 ヒロイン専用）───
    // ホワイトノイズ → HPF(2500Hz) → breathGain → compressor
    // breathGain.gain=0 のときは無音（他プリセットに影響なし）
    const noiseLen = ctx.sampleRate; // 1秒ループ
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;

    this.breathSrc = ctx.createBufferSource();
    this.breathSrc.buffer = noiseBuf;
    this.breathSrc.loop   = true;
    this.breathSrc.start();

    this.breathHPF = ctx.createBiquadFilter();
    this.breathHPF.type            = 'highpass';
    this.breathHPF.frequency.value = 2500;
    this.breathHPF.Q.value         = 0.7;

    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0; // 初期値 0（無効）

    this.breathSrc.connect(this.breathHPF);
    this.breathHPF.connect(this.breathGain);
    // breathGain → compressor は _buildGraph 内で接続
    // ─────────────────────────────────────────────

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

    // ─── 既存接続を全解除 ───
    try { this.sourceNode.disconnect();  } catch {}
    try { this.pitchNode.disconnect();   } catch {}
    try { this.hpFilter.disconnect();    } catch {}
    try { this.lsFilter.disconnect();    } catch {}
    try { this.pkFilter.disconnect();    } catch {}
    try { this.hsFilter.disconnect();    } catch {}
    try { this.compressor.disconnect();  } catch {}
    try { this.breathGain.disconnect();  } catch {}

    // ─── ピッチ・フォルマント設定 ───
    this.pitchNode.parameters.get('pitchRatio').value   = p.pitchRatio;
    this.pitchNode.parameters.get('formantRatio').value = p.formantRatio ?? 1.0;

    // ─── EQ 設定 ───
    this.lsFilter.frequency.value = p.lsFreq  ?? 200;
    this.lsFilter.gain.value      = p.lsGain  ?? 0;
    this.pkFilter.frequency.value = p.pkFreq  ?? 1000;
    this.pkFilter.gain.value      = p.pkGain  ?? 0;
    this.hsFilter.frequency.value = p.hsFreq  ?? 5000;
    this.hsFilter.gain.value      = p.hsGain  ?? 0;

    // ─── 息感ノイズ設定 ───
    this.breathGain.gain.value = p.breathMix ?? 0;

    // ─── グラフ接続 ───
    // source → pitch → [HP →] LS → PK → HS → comp → dest
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

    // 息感ノイズ → comp（breathMix=0のときは接続するが無音）
    this.breathGain.connect(this.compressor);

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
    this.breathSrc?.stop();
    this.sourceNode?.disconnect();
    this.audioContext?.close();
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
