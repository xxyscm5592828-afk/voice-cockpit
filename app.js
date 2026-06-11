// =============================================================================
// 声音驾驶舱 - 主程序
// =============================================================================
//
// 文件分区：
//   SECTION 1: 常量 & 配置
//   SECTION 2: 纯工具函数（note/freq/cents 转换）
//   SECTION 3: 音频采集 + 音高检测
//   SECTION 4: Canvas 绘制工具
//   SECTION 5: 旋律数据
//   SECTION 6-9: 4 个训练模式
//   SECTION 10: 状态机
//   SECTION 11: UI 控件
//   SECTION 12: 初始化
// =============================================================================

// === SECTION 1: 常量 & 配置 ===
const CONFIG = {
  FFT_SIZE: 2048,
  PITCH_MIN_HZ: 75,    // 约 D2
  PITCH_MAX_HZ: 1100,  // 约 C#6
  SAMPLE_INTERVAL_MS: 50,
  REFERENCE_GAIN: 0.2,
  CENTS_THRESHOLD: 50,  // 跟唱模式判定"准" / "跑调"
  STABILITY_WINDOW_S: 2,
  SMOOTHNESS_THRESHOLD: 50,  // 引擎滑音模式
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const COLORS = {
  USER: '#10b981',
  USER_BAD: '#ef4444',
  REFERENCE: '#f59e0b',
  TARGET: '#f1f5f9',
  FUSION: '#fbbf24',
  GRID: '#334155',
  TEXT_DIM: '#94a3b8',
};

// === SECTION 2: 纯工具函数 ===

// MIDI 音符号：A4 = 69 = 440Hz
function freqToNoteNumber(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function noteNumberToFreq(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

// 返回音名+八度，如 "A4"
function freqToNoteName(freq) {
  const n = Math.round(freqToNoteNumber(freq));
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return name + octave;
}

// 频率1 相对频率2 的音分差（正=更尖锐）
function freqToCents(f1, f2) {
  return 1200 * Math.log2(f1 / f2);
}

// 当前是否在 CENTS_THRESHOLD 范围内
function isInTune(userFreq, targetFreq) {
  return Math.abs(freqToCents(userFreq, targetFreq)) <= CONFIG.CENTS_THRESHOLD;
}

// 计算最近 N 秒窗口的稳定度（0-1）
function calcStability(centsHistory) {
  if (centsHistory.length < 2) return 0;
  const mean = centsHistory.reduce((a, b) => a + b, 0) / centsHistory.length;
  const variance = centsHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / centsHistory.length;
  const std = Math.sqrt(variance);
  return Math.max(0, 1 - Math.min(std, 50) / 50);
}

// 计算最近 N 帧的曲线斜率标准差 -> 平滑度（0-1）
function calcSmoothness(pitchHistory) {
  if (pitchHistory.length < 3) return 0;
  // pitchHistory 是 cents 数组
  const slopes = [];
  for (let i = 1; i < pitchHistory.length; i++) {
    slopes.push(pitchHistory[i] - pitchHistory[i - 1]);
  }
  const mean = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const variance = slopes.reduce((a, b) => a + (b - mean) ** 2, 0) / slopes.length;
  const std = Math.sqrt(variance);
  return Math.max(0, 1 - Math.min(std, CONFIG.SMOOTHNESS_THRESHOLD) / CONFIG.SMOOTHNESS_THRESHOLD);
}

// === Node 导出（仅测试用）===
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    freqToNoteNumber, noteNumberToFreq, freqToNoteName, freqToCents,
    isInTune, calcStability, calcSmoothness,
  };
}
export { freqToNoteNumber, noteNumberToFreq, freqToNoteName, freqToCents, isInTune, calcStability, calcSmoothness };

// === SECTION 3: 音频采集 + 音高检测 ===

class PitchEngine {
  constructor() {
    this.audioCtx = null;
    this.stream = null;
    this.analyser = null;
    this.buffer = null;
    this.detector = null;
    this.running = false;
    this.onPitch = null;  // (freqHz | null, clarity) => void
    this.onLevel = null;  // (rms 0-1) => void
    this._timer = null;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = CONFIG.FFT_SIZE;
    source.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.detector = PitchDetector.forFloat32Array(this.analyser.fftSize);
    this.running = true;
    this._loop();
  }

  _loop() {
    if (!this.running) return;
    this.analyser.getFloatTimeDomainData(this.buffer);

    // RMS 电平
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      sum += this.buffer[i] * this.buffer[i];
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    if (this.onLevel) this.onLevel(rms);
    if (rms < 0.005) watchSilence(); else clearSilenceWatch();

    // 音高
    const [pitch, clarity] = this.detector.findPitch(this.buffer, this.audioCtx.sampleRate);
    if (pitch >= CONFIG.PITCH_MIN_HZ && pitch <= CONFIG.PITCH_MAX_HZ && clarity > 0.9) {
      if (this.onPitch) this.onPitch(pitch, clarity);
    } else {
      if (this.onPitch) this.onPitch(null, 0);
    }

    this._timer = setTimeout(() => this._loop(), CONFIG.SAMPLE_INTERVAL_MS);
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audioCtx) this.audioCtx.close();
    this.audioCtx = null;
    this.stream = null;
    this.analyser = null;
  }
}

// 错误处理 stub - 在 Task 11 中填充真实实现
function watchSilence() {}
function clearSilenceWatch() {}

if (typeof document !== 'undefined') {
  const onReady = () => {
    const engine = new PitchEngine();
    const currentNoteEl = document.getElementById('current-note');
    const levelFill = document.getElementById('level-fill');

    engine.onPitch = (freq) => {
      currentNoteEl.textContent = freq ? freqToNoteName(freq) : '—';
    };
    engine.onLevel = (rms) => {
      // rms 通常 0-0.5，放大显示
      levelFill.style.width = Math.min(100, rms * 400) + '%';
    };

    document.getElementById('primary-btn').addEventListener('click', async () => {
      try {
        await engine.start();
        document.getElementById('primary-btn').textContent = '运行中…';
      } catch (e) {
        showError('麦克风启动失败：' + e.message);
      }
    });

    function showError(msg) {
      const banner = document.getElementById('error-banner');
      banner.textContent = msg;
      banner.hidden = false;
    }

    console.log('声音驾驶舱已加载');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
}
