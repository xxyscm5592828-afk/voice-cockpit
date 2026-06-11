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

// 把音名转成 MIDI 数字（"C4" → 60）
function noteNameToMidi(name) {
  const m = name.match(/^([A-G]#?)(\d)$/);
  if (!m) return 60;
  const idx = NOTE_NAMES.indexOf(m[1]);
  const octave = parseInt(m[2]);
  return (octave + 1) * 12 + idx;
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

// 中值滤波器：用最近 N 个采样点的中位数平滑曲线
class MedianFilter {
  constructor(size = 3) {
    this.size = size;
    this.buffer = [];
  }
  push(value) {
    this.buffer.push(value);
    if (this.buffer.length > this.size) this.buffer.shift();
    return this._median();
  }
  reset() {
    this.buffer = [];
  }
  _median() {
    if (this.buffer.length === 0) return null;
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}

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
    // 中值滤波器，平滑音高曲线（保留原值无 clarity 时仍可用）
    this.pitchFilter = new MedianFilter(3);
    this.lastSmoothed = null;
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

    // 音高 - 经过中值滤波后传给 onPitch
    const [pitch, clarity] = this.detector.findPitch(this.buffer, this.audioCtx.sampleRate);
    if (pitch >= CONFIG.PITCH_MIN_HZ && pitch <= CONFIG.PITCH_MAX_HZ && clarity > 0.9) {
      const smoothed = this.pitchFilter.push(pitch);
      this.lastSmoothed = smoothed;
      if (this.onPitch) this.onPitch(smoothed, clarity);
    } else {
      this.pitchFilter.reset();
      this.lastSmoothed = null;
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

// === SECTION 13: 错误处理 ===

function checkBrowserSupport() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('您的浏览器不支持麦克风访问，请用 Chrome / Edge / Safari 最新版');
    document.getElementById('primary-btn').disabled = true;
    return false;
  }
  if (!window.AudioContext && !window.webkitAudioContext) {
    showError('您的浏览器不支持 Web Audio，请用 Chrome / Edge / Safari 最新版');
    document.getElementById('primary-btn').disabled = true;
    return false;
  }
  return true;
}

function handlePermissionError(err) {
  const msg = err.name === 'NotAllowedError'
    ? '麦克风权限被拒绝。请在浏览器设置中允许本网站使用麦克风。'
    : '麦克风启动失败：' + (err.message || err.name);
  showError(msg);
}

let silenceTimer = null;
function watchSilence() {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    if (currentState === STATE.RECORDING_GLISSANDO || currentState === STATE.RECORDING_STABLE || currentState === STATE.LISTENING) {
      showError('听不清，请再发一次');
    }
  }, 3000);
}

function clearSilenceWatch() {
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
}

// === SECTION 4: Canvas 绘制工具 ===

class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);  // 重置
    this.ctx.scale(dpr, dpr);
    this.w = rect.width;
    this.h = rect.height;
  }

  clear() {
    this.ctx.fillStyle = '#0f172a';
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  // 画水平网格 + y 轴刻度标签
  drawGrid(yMin, yMax, yFormatter) {
    this.ctx.strokeStyle = COLORS.GRID;
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = COLORS.TEXT_DIM;
    this.ctx.font = '12px sans-serif';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = (this.h / 4) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.w, y);
      this.ctx.stroke();
      const yVal = yMax - (yMax - yMin) * (i / 4);
      this.ctx.fillText(yFormatter(yVal), 6, y);
    }
  }

  // 在 y 值处画水平虚线
  drawTargetLine(yValue, yMin, yMax, color = COLORS.TARGET, label = '') {
    const y = this.h - (yValue - yMin) / (yMax - yMin) * this.h;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([6, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(0, y);
    this.ctx.lineTo(this.w, y);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    if (label) {
      this.ctx.fillStyle = color;
      this.ctx.fillText(label, this.w - 60, y - 8);
    }
  }

  // 画最近 N 个采样点
  drawCurve(samples, yMin, yMax, color = COLORS.USER, lineWidth = 2.5) {
    if (samples.length < 2) return;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * this.w;
      const yNorm = (samples[i] - yMin) / (yMax - yMin);
      const y = this.h - Math.max(0, Math.min(1, yNorm)) * this.h;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();
  }

  // 用 MIDI 数字画 Y 轴音名网格（"C4" ~ "C5"）
  drawNoteGrid(minNote, maxNote) {
    const minMidi = noteNameToMidi(minNote);
    const maxMidi = noteNameToMidi(maxNote);
    this.ctx.strokeStyle = COLORS.GRID;
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = COLORS.TEXT_DIM;
    this.ctx.font = '12px sans-serif';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'middle';
    for (let m = minMidi; m <= maxMidi; m++) {
      const y = this.h - (m - minMidi) / (maxMidi - minMidi) * this.h;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.w, y);
      this.ctx.stroke();
      // 音名 = C, C#, D, ... B（不带八度）
      const noteName = NOTE_NAMES[((m % 12) + 12) % 12];
      this.ctx.fillText(noteName, 5, y);
    }
  }

  // 用 MIDI 数字画曲线（pitchHistoryMidi 用之）
  drawCurveByMidi(samples, minMidi, maxMidi, color = COLORS.USER, lineWidth = 2.5) {
    if (samples.length < 2) return;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * this.w;
      const yNorm = (samples[i] - minMidi) / (maxMidi - minMidi);
      const y = this.h - Math.max(0, Math.min(1, yNorm)) * this.h;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();
  }

  // 当前音高指示（右侧条 + 音名标签）
  drawCurrentPitchIndicator(midi, minMidi, maxMidi, noteName, color = COLORS.USER) {
    if (midi == null) return;
    const yNorm = (midi - minMidi) / (maxMidi - minMidi);
    const y = this.h - Math.max(0, Math.min(1, yNorm)) * this.h;
    // 发光横线
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.shadowColor = color;
    this.ctx.shadowBlur = 10;
    this.ctx.beginPath();
    this.ctx.moveTo(0, y);
    this.ctx.lineTo(this.w, y);
    this.ctx.stroke();
    this.ctx.shadowBlur = 0;
    // 音名标签（右上角）
    this.ctx.fillStyle = color;
    this.ctx.font = 'bold 24px sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.fillText(noteName, this.w - 8, y - 12);
  }

  // 当前音高脉冲点（带相位动画）
  drawPitchDot(midi, minMidi, maxMidi, phase, color = COLORS.USER) {
    if (midi == null) return;
    const x = this.w - 50;
    const yNorm = (midi - minMidi) / (maxMidi - minMidi);
    const y = this.h - Math.max(0, Math.min(1, yNorm)) * this.h;
    const radius = 8 + Math.sin(phase) * 3;
    // 光晕
    const grad = this.ctx.createRadialGradient(x, y, 0, x, y, radius * 4);
    grad.addColorStop(0, color + 'cc');
    grad.addColorStop(1, color + '00');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(x - radius * 4, y - radius * 4, radius * 8, radius * 8);
    // 实心点
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  // 在指定位置画一个点（用于标记融合点等）
  drawMarker(xRatio, yValue, yMin, yMax, color = COLORS.FUSION, radius = 8) {
    const x = xRatio * this.w;
    const yNorm = (yValue - yMin) / (yMax - yMin);
    const y = this.h - Math.max(0, Math.min(1, yNorm)) * this.h;
    // 光晕
    const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius * 3);
    gradient.addColorStop(0, color + 'cc');
    gradient.addColorStop(1, color + '00');
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(x - radius * 3, y - radius * 3, radius * 6, radius * 6);
    // 实心圆
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }
}

// === SECTION 5: 旋律数据 ===

// 每首: { name, bpm, notes: [{note, start, duration}] }
// 起始 start 单位 = 秒
const MELODIES = {
  happy_birthday: {
    name: '生日快乐',
    bpm: 120,
    notes: [
      // 第一句: Happy birthday to you
      { note: 'C4', start: 0.0,  duration: 0.5 },
      { note: 'C4', start: 0.5,  duration: 0.25 },
      { note: 'D4', start: 0.75, duration: 0.75 },
      { note: 'C4', start: 1.5,  duration: 0.75 },
      { note: 'F4', start: 2.25, duration: 0.75 },
      { note: 'E4', start: 3.0,  duration: 1.5 },
      // 第二句: Happy birthday to you
      { note: 'C4', start: 4.5,  duration: 0.5 },
      { note: 'C4', start: 5.0,  duration: 0.25 },
      { note: 'D4', start: 5.25, duration: 0.75 },
      { note: 'C4', start: 6.0,  duration: 0.75 },
      { note: 'G4', start: 6.75, duration: 0.75 },
      { note: 'F4', start: 7.5,  duration: 1.5 },
      // 第三句: Happy birthday dear ___
      { note: 'C4', start: 9.0,  duration: 0.5 },
      { note: 'C4', start: 9.5,  duration: 0.25 },
      { note: 'C5', start: 9.75, duration: 0.75 },
      { note: 'A4', start: 10.5, duration: 0.75 },
      { note: 'F4', start: 11.25, duration: 0.75 },
      { note: 'E4', start: 12.0, duration: 0.75 },
      { note: 'D4', start: 12.75, duration: 0.75 },
      // 第四句: Happy birthday to you
      { note: 'Bb4', start: 13.5, duration: 0.5 },
      { note: 'Bb4', start: 14.0, duration: 0.25 },
      { note: 'A4', start: 14.25, duration: 0.75 },
      { note: 'F4', start: 15.0, duration: 0.75 },
      { note: 'G4', start: 15.75, duration: 0.75 },
      { note: 'F4', start: 16.5, duration: 1.5 },
    ],
  },

  twinkle: {
    name: '小星星',
    bpm: 120,
    notes: [
      { note: 'C4', start: 0.0,  duration: 0.5 },
      { note: 'C4', start: 0.5,  duration: 0.5 },
      { note: 'G4', start: 1.0,  duration: 0.5 },
      { note: 'G4', start: 1.5,  duration: 0.5 },
      { note: 'A4', start: 2.0,  duration: 0.5 },
      { note: 'A4', start: 2.5,  duration: 0.5 },
      { note: 'G4', start: 3.0,  duration: 1.0 },
      { note: 'F4', start: 4.0,  duration: 0.5 },
      { note: 'F4', start: 4.5,  duration: 0.5 },
      { note: 'E4', start: 5.0,  duration: 0.5 },
      { note: 'E4', start: 5.5,  duration: 0.5 },
      { note: 'D4', start: 6.0,  duration: 0.5 },
      { note: 'D4', start: 6.5,  duration: 0.5 },
      { note: 'C4', start: 7.0,  duration: 1.0 },
    ],
  },
};

function melodyTotalDuration(melody) {
  return melody.notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0);
}

function findCurrentNote(melody, t) {
  for (const n of melody.notes) {
    if (t >= n.start && t < n.start + n.duration) return n;
  }
  return null;
}

function noteNameToFreq(name) {
  // name like "C4", "F#5", "Bb4"
  const m = name.match(/^([A-G]#?)(\d)$/);
  if (!m) return 440;
  const idx = NOTE_NAMES.indexOf(m[1]);
  const octave = parseInt(m[2]);
  const noteNum = (octave + 1) * 12 + idx;
  return noteNumberToFreq(noteNum);
}

// === SECTION 6: 模式 1 - 引擎滑音 ===

// pitchHistoryMidi: 存 MIDI 数字，给音名 Y 轴可视化用
let pitchHistoryMidi = [];

// 当前 session 指标 + 开始时间（统计用）
let sessionStartMs = null;
let sessionMetrics = {
  glissando: { bestSmoothness: 0 },
  cruise: { bestStability: 0 },
  resonance: { completed: false },
  follow: { bestAccuracy: 0 },
};

function startGlissando() {
  setState(STATE.RECORDING_GLISSANDO);
  sessionStartMs = performance.now();
  sessionMetrics.glissando = { bestSmoothness: 0 };
  // pitchHistory 已经在 onModeChange 中清空
  const modeReadout = document.getElementById('mode-readout');
  // 实时计算平滑度
  engine.onPitch = (freq) => {
    if (freq) {
      const cents = freqToCents(freq, 440);
      const midi = freqToNoteNumber(freq);
      pitchHistory.push(cents);
      pitchHistoryMidi.push(midi);
      if (pitchHistory.length > 100) pitchHistory.shift();
      if (pitchHistoryMidi.length > 100) pitchHistoryMidi.shift();
    } else {
      pitchHistory.push(null);
      pitchHistoryMidi.push(null);
      if (pitchHistory.length > 100) pitchHistory.shift();
      if (pitchHistoryMidi.length > 100) pitchHistoryMidi.shift();
    }
    currentNoteEl.textContent = freq ? freqToNoteName(freq) : '—';
    const smoothness = calcSmoothness(pitchHistory.filter(x => x !== null));
    modeReadout.textContent = `平滑度: ${Math.round(smoothness * 100)}%`;
    if (smoothness > sessionMetrics.glissando.bestSmoothness) {
      sessionMetrics.glissando.bestSmoothness = smoothness;
    }
  };
}

// === SECTION 7: 模式 2 - 直线巡航 ===

let cruiseTargetFreq = 440;  // 默认 A4
let cruiseHistory = [];      // cents 偏离历史（最近 2 秒 = 40 帧）

function startCruise() {
  setState(STATE.RECORDING_STABLE);
  sessionStartMs = performance.now();
  sessionMetrics.cruise = { bestStability: 0 };
  cruiseHistory = [];
  const modeReadout = document.getElementById('mode-readout');
  // 临时把「模式相关数值」改为显示目标音 + 偏离
  modeReadout.innerHTML = `目标: A4 | 偏离: <strong id="deviation">—</strong> | 稳定度: <strong id="stability">—</strong>`;
  // 暂停 global onPitch，重写
  engine.onPitch = (freq) => {
    if (!freq) {
      document.getElementById('deviation').textContent = '—';
      cruiseHistory.push(null);
    } else {
      const cents = freqToCents(freq, cruiseTargetFreq);
      document.getElementById('deviation').textContent = (cents >= 0 ? '+' : '') + cents.toFixed(0) + ' cents';
      cruiseHistory.push(cents);
    }
    if (cruiseHistory.length > 40) cruiseHistory.shift();
    const valid = cruiseHistory.filter(x => x !== null);
    if (valid.length > 1) {
      const stab = calcStability(valid);
      document.getElementById('stability').textContent = Math.round(stab * 100) + '%';
      if (stab > sessionMetrics.cruise.bestStability) {
        sessionMetrics.cruise.bestStability = stab;
      }
    }
  };
}

// === SECTION 8: 模式 3 - 共振对齐 ===

let resonanceLockedFreq = null;
let resonanceOsc = null;
let resonanceGain = null;
let resonanceAudioCtx = null;  // 提升到全局，便于停止时关闭
let resonanceStartTime = 0;
let resonanceSamples = [];  // {t, userFreq, refFreq}

function startResonance() {
  setState(STATE.LISTENING);
  sessionStartMs = performance.now();
  sessionMetrics.resonance = { completed: false };
  resonanceSamples = [];
  const modeReadout = document.getElementById('mode-readout');
  modeReadout.textContent = '请发一个稳定的「啊」';
  resonanceLockedFreq = null;

  // 检测音高稳定 1 秒 → LOCKED
  const stableWindow = [];  // 最近的 cents 偏离
  const targetWindow = 100;  // cents
  engine.onPitch = (freq) => {
    if (!freq) {
      stableWindow.length = 0;
      return;
    }
    const cents = freqToCents(freq, 440);  // 用 A4 作临时参考
    stableWindow.push(cents);
    if (stableWindow.length > 20) stableWindow.shift();
    if (stableWindow.length >= 20) {
      const std = (() => {
        const mean = stableWindow.reduce((a, b) => a + b, 0) / stableWindow.length;
        const v = stableWindow.reduce((a, b) => a + (b - mean) ** 2, 0) / stableWindow.length;
        return Math.sqrt(v);
      })();
      if (std < 30) {
        // 稳定了！锁定当前频率
        const avgFreq = noteNumberToFreq(freqToNoteNumber(freq));
        resonanceLockedFreq = avgFreq;
        onResonanceLocked();
      }
    }
  };
}

function onResonanceLocked() {
  setState(STATE.LOCKED);
  document.getElementById('mode-readout').textContent =
    `已锁定 ${freqToNoteName(resonanceLockedFreq)} @ ${resonanceLockedFreq.toFixed(1)}Hz`;

  setTimeout(() => {
    setState(STATE.PLAYING);
    startResonanceGlissando();
  }, 1200);
}

function startResonanceGlissando() {
  const startFreq = resonanceLockedFreq * Math.pow(2, -3 / 12);  // 低 3 个半音
  const endFreq = resonanceLockedFreq;
  const duration = 3.0;  // 秒

  // 启动参考音
  resonanceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  resonanceOsc = resonanceAudioCtx.createOscillator();
  resonanceGain = resonanceAudioCtx.createGain();
  resonanceOsc.type = 'sine';
  resonanceOsc.frequency.setValueAtTime(startFreq, resonanceAudioCtx.currentTime);
  resonanceOsc.frequency.linearRampToValueAtTime(endFreq, resonanceAudioCtx.currentTime + duration);
  resonanceGain.gain.setValueAtTime(0, resonanceAudioCtx.currentTime);
  resonanceGain.gain.linearRampToValueAtTime(CONFIG.REFERENCE_GAIN, resonanceAudioCtx.currentTime + 0.05);
  resonanceGain.gain.setValueAtTime(CONFIG.REFERENCE_GAIN, resonanceAudioCtx.currentTime + duration);
  resonanceGain.gain.linearRampToValueAtTime(0, resonanceAudioCtx.currentTime + duration + 0.5);
  resonanceOsc.connect(resonanceGain).connect(resonanceAudioCtx.destination);
  resonanceOsc.start();
  resonanceOsc.stop(resonanceAudioCtx.currentTime + duration + 0.6);

  // 收集样本 + 重写 onPitch 记录用户音高
  resonanceStartTime = performance.now();
  resonanceSamples = [];
  const t0 = resonanceStartTime;
  engine.onPitch = (freq) => {
    const t = (performance.now() - t0) / 1000;
    resonanceSamples.push({ t, userFreq: freq, refFreq: startFreq + (endFreq - startFreq) * Math.min(1, t / duration) });
    currentNoteEl.textContent = freq ? freqToNoteName(freq) : '—';
  };

  // 结束
  setTimeout(() => {
    setState(STATE.FUSED);
    sessionMetrics.resonance.completed = true;
    document.getElementById('mode-readout').textContent = '感受到了吗？那就是「准」的感觉';
  }, (duration + 0.6) * 1000);
}

// 在 renderLoop 中画共振对齐：x = 时间 0~3.5s, y = 频率
function renderResonance() {
  if (currentMode !== 'resonance') return;
  if (![STATE.LOCKED, STATE.PLAYING, STATE.FUSED].includes(currentState)) return;
  const t0 = resonanceStartTime || performance.now();
  const tNow = (performance.now() - t0) / 1000;
  const xMax = 3.5;
  const yMin = 200, yMax = 600;
  viz.clear();
  viz.drawGrid(yMin, yMax, (v) => v.toFixed(0) + 'Hz');

  // 画参考曲线（用 resample 至 xMax）
  const refSamples = [];
  for (let i = 0; i <= 50; i++) {
    const t = (i / 50) * xMax;
    if (t > tNow + 0.2) break;
    const startFreq = resonanceLockedFreq * Math.pow(2, -3 / 12);
    const endFreq = resonanceLockedFreq;
    const dur = 3.0;
    const refFreq = startFreq + (endFreq - startFreq) * Math.min(1, t / dur);
    refSamples.push(t / xMax, refFreq);
  }
  // 用户曲线
  const userXs = [], userYs = [];
  for (const s of resonanceSamples) {
    if (s.t > xMax) break;
    if (s.userFreq) {
      userXs.push(s.t / xMax);
      userYs.push(s.userFreq);
    }
  }
  if (userXs.length > 1) {
    // 用 Visualizer 的 drawCurve，但它是按数组顺序画，这里要按 x 比例画
    viz.ctx.strokeStyle = COLORS.USER;
    viz.ctx.lineWidth = 2.5;
    viz.ctx.beginPath();
    for (let i = 0; i < userXs.length; i++) {
      const x = userXs[i] * viz.w;
      const yNorm = (userYs[i] - yMin) / (yMax - yMin);
      const y = viz.h - Math.max(0, Math.min(1, yNorm)) * viz.h;
      if (i === 0) viz.ctx.moveTo(x, y);
      else viz.ctx.lineTo(x, y);
    }
    viz.ctx.stroke();
  }
  if (refSamples.length > 1) {
    viz.ctx.strokeStyle = COLORS.REFERENCE;
    viz.ctx.lineWidth = 2.5;
    viz.ctx.beginPath();
    for (let i = 0; i < refSamples.length; i += 2) {
      const x = refSamples[i] * viz.w;
      const yNorm = (refSamples[i + 1] - yMin) / (yMax - yMin);
      const y = viz.h - Math.max(0, Math.min(1, yNorm)) * viz.h;
      if (i === 0) viz.ctx.moveTo(x, y);
      else viz.ctx.lineTo(x, y);
    }
    viz.ctx.stroke();
  }
  // 融合点（在 x = 3/3.5）
  if (currentState === STATE.FUSED) {
    viz.drawMarker(3.0 / 3.5, resonanceLockedFreq, yMin, yMax, COLORS.FUSION, 10);
  }
}

// === SECTION 9: 模式 4 - 跟唱旋律 ===

let followMelody = null;
let followAudioCtx = null;
let followOsc = null;
let followGain = null;
let followStartTime = 0;
let followSamples = [];  // {t, userFreq, targetFreq, inTune}
let followOnTarget = 0;  // 在调帧数
let followTotal = 0;       // 总帧数

function startFollow() {
  // MVP 简单版：直接用第一首旋律
  followMelody = MELODIES.happy_birthday;
  followSamples = [];
  followOnTarget = 0;
  followTotal = 0;
  sessionStartMs = performance.now();
  sessionMetrics.follow = { bestAccuracy: 0 };

  setState(STATE.COUNTDOWN);
  document.getElementById('mode-readout').textContent = '3...';
  let n = 3;
  const cd = setInterval(() => {
    n--;
    if (n > 0) {
      document.getElementById('mode-readout').textContent = n + '...';
    } else {
      clearInterval(cd);
      actuallyStartFollow();
    }
  }, 1000);
}

function actuallyStartFollow() {
  setState(STATE.SINGING);
  followAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  followGain = followAudioCtx.createGain();
  followGain.gain.value = CONFIG.REFERENCE_GAIN;
  followGain.connect(followAudioCtx.destination);

  // 调度所有音符
  const t0 = followAudioCtx.currentTime + 0.1;
  for (const n of followMelody.notes) {
    const osc = followAudioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = noteNameToFreq(n.note);
    // 短 envelope 避免爆音
    const g = followAudioCtx.createGain();
    g.gain.setValueAtTime(0, t0 + n.start);
    g.gain.linearRampToValueAtTime(1, t0 + n.start + 0.01);
    g.gain.setValueAtTime(1, t0 + n.start + n.duration - 0.01);
    g.gain.linearRampToValueAtTime(0, t0 + n.start + n.duration);
    osc.connect(g).connect(followGain);
    osc.start(t0 + n.start);
    osc.stop(t0 + n.start + n.duration + 0.01);
  }

  followStartTime = performance.now() + 100;  // 同步
  const audioT0 = t0;

  // 检测用户音高
  engine.onPitch = (freq) => {
    const t = (performance.now() - followStartTime) / 1000;
    if (t < 0) return;
    const target = findCurrentNote(followMelody, t);
    const targetFreq = target ? noteNameToFreq(target.note) : null;
    const inTune = (freq && targetFreq) ? isInTune(freq, targetFreq) : null;
    followSamples.push({ t, userFreq: freq, targetFreq, inTune });
    if (inTune !== null) {
      followTotal++;
      if (inTune) followOnTarget++;
    }
    currentNoteEl.textContent = freq ? freqToNoteName(freq) : (target ? target.note : '—');
    if (followTotal > 0) {
      const acc = followOnTarget / followTotal;
      document.getElementById('mode-readout').textContent =
        `当前: ${target ? target.note : '—'} | 准确率: ${Math.round(acc * 100)}%`;
      if (acc > sessionMetrics.follow.bestAccuracy) {
        sessionMetrics.follow.bestAccuracy = acc;
      }
    }
  };

  // 结束后进入 RESULT
  const totalDur = melodyTotalDuration(followMelody);
  setTimeout(() => {
    setState(STATE.RESULT);
    const acc = followTotal > 0 ? Math.round(followOnTarget / followTotal * 100) : 0;
    document.getElementById('mode-readout').innerHTML = `🎉 准确率: <strong>${acc}%</strong>`;
  }, (totalDur + 0.2) * 1000);
}

// 渲染：x = 时间 0~总时长, y = 频率
function renderFollow() {
  if (currentMode !== 'follow') return;
  if (![STATE.SINGING, STATE.RESULT].includes(currentState)) return;
  const melody = followMelody;
  if (!melody) return;
  const total = melodyTotalDuration(melody);
  const yMin = noteNameToFreq('C4') * 0.9;
  const yMax = noteNameToFreq('C5') * 1.1;
  viz.clear();
  viz.drawGrid(yMin, yMax, (v) => v.toFixed(0) + 'Hz');

  // 目标曲线：阶梯化
  const tNow = currentState === STATE.RESULT ? total : (performance.now() - followStartTime) / 1000;
  viz.ctx.strokeStyle = COLORS.REFERENCE;
  viz.ctx.lineWidth = 2.5;
  viz.ctx.beginPath();
  let started = false;
  for (const n of melody.notes) {
    if (n.start > tNow + 0.1) break;
    const f = noteNameToFreq(n.note);
    const x1 = (n.start / total) * viz.w;
    const x2 = Math.min(tNow, n.start + n.duration) / total * viz.w;
    if (x1 >= viz.w) break;
    const yNorm = (f - yMin) / (yMax - yMin);
    const y = viz.h - Math.max(0, Math.min(1, yNorm)) * viz.h;
    if (!started) { viz.ctx.moveTo(x1, y); started = true; }
    else viz.ctx.lineTo(x1, y);
    viz.ctx.lineTo(x2, y);
  }
  viz.ctx.stroke();

  // 用户曲线（按 inTune 着色）
  const pts = followSamples.filter(s => s.t <= tNow);
  for (let i = 1; i < pts.length; i++) {
    if (!pts[i].userFreq || !pts[i - 1].userFreq) continue;
    const color = pts[i].inTune ? COLORS.USER : COLORS.USER_BAD;
    viz.ctx.strokeStyle = color;
    viz.ctx.lineWidth = 2.5;
    viz.ctx.beginPath();
    const x1 = (pts[i - 1].t / total) * viz.w;
    const x2 = (pts[i].t / total) * viz.w;
    const y1N = (pts[i - 1].userFreq - yMin) / (yMax - yMin);
    const y2N = (pts[i].userFreq - yMin) / (yMax - yMin);
    const y1 = viz.h - Math.max(0, Math.min(1, y1N)) * viz.h;
    const y2 = viz.h - Math.max(0, Math.min(1, y2N)) * viz.h;
    viz.ctx.moveTo(x1, y1);
    viz.ctx.lineTo(x2, y2);
    viz.ctx.stroke();
  }
}

// === SECTION 10: 状态机 ===

const STATE = {
  IDLE: 'IDLE',
  RECORDING_GLISSANDO: 'RECORDING_GLISSANDO',
  RECORDING_STABLE: 'RECORDING_STABLE',
  LISTENING: 'LISTENING',         // 共振对齐
  LOCKED: 'LOCKED',
  PLAYING: 'PLAYING',
  FUSED: 'FUSED',
  CHOOSE_MELODY: 'CHOOSE_MELODY',  // 跟唱
  COUNTDOWN: 'COUNTDOWN',
  SINGING: 'SINGING',
  RESULT: 'RESULT',
};

let currentState = STATE.IDLE;
let currentMode = 'glissando';  // glissando | cruise | resonance | follow

function setState(newState) {
  console.log(`state: ${currentState} → ${newState}`);
  currentState = newState;
  updateUI();
}

function updateUI() {
  const primary = document.getElementById('primary-btn');
  const secondary = document.getElementById('secondary-btn');
  const modeReadout = document.getElementById('mode-readout');

  // 简化版：先让按钮逻辑跑通
  switch (currentState) {
    case STATE.IDLE:
      primary.hidden = false;
      secondary.hidden = true;
      primary.textContent = '▶ 开始';
      break;
    case STATE.RECORDING_GLISSANDO:
    case STATE.RECORDING_STABLE:
    case STATE.LISTENING:
    case STATE.LOCKED:
    case STATE.PLAYING:
    case STATE.SINGING:
    case STATE.COUNTDOWN:
      primary.hidden = true;
      secondary.hidden = false;
      secondary.textContent = '停止';
      break;
    case STATE.FUSED:
      primary.hidden = true;
      secondary.hidden = false;
      secondary.textContent = '停止';
      break;
    case STATE.RESULT:
      primary.hidden = false;
      secondary.hidden = true;
      primary.textContent = '再来一次';
      break;
  }
}

// === SECTION 11: UI 控件 ===

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (currentState !== STATE.IDLE) {
        showError('请先停止当前练习再切换模式');
        return;
      }
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.mode;
      onModeChange();
    });
  });
}

function onModeChange() {
  pitchHistory.length = 0;
  pitchHistoryMidi.length = 0;
  cruiseHistory = [];
  viz.clear();
  currentNoteEl.textContent = '—';
  const labels = { glissando: '引擎滑音', cruise: '直线巡航', resonance: '共振对齐', follow: '跟唱' };
  document.getElementById('mode-readout').textContent = labels[currentMode];
  // 清掉 error banner
  document.getElementById('error-banner').hidden = true;
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.hidden = false;
  setTimeout(() => { banner.hidden = true; }, 4000);
}

// === SECTION 12: 初始化 ===

let engine, viz, currentNoteEl, levelFill, pitchHistory;

// 动画相位：每帧递增，给 drawPitchDot 脉冲用
let animPhase = 0;

if (typeof document !== 'undefined') {
  const onReady = () => {
    if (!checkBrowserSupport()) return;
    engine = new PitchEngine();
    viz = new Visualizer(document.getElementById('canvas'));
    currentNoteEl = document.getElementById('current-note');
    levelFill = document.getElementById('level-fill');
    pitchHistory = [];

    engine.onPitch = (freq) => {
      const cents = freq ? freqToCents(freq, 440) : null;
      pitchHistory.push(cents);
      if (pitchHistory.length > 100) pitchHistory.shift();
      currentNoteEl.textContent = freq ? freqToNoteName(freq) : '—';
    };
    engine.onLevel = (rms) => {
      levelFill.style.width = Math.min(100, rms * 400) + '%';
    };

    // 引擎滑音模式的 MIDI Y 轴范围（C4 ~ C5）
    const GLISSANDO_MIN_MIDI = 60;
    const GLISSANDO_MAX_MIDI = 72;

    function renderLoop() {
      viz.clear();
      if (currentMode === 'glissando') {
        // 引擎滑音：音名 Y 轴 + MIDI 曲线 + 当前音高指示 + 脉冲点
        viz.drawNoteGrid('C4', 'C5');
        viz.drawCurveByMidi(pitchHistoryMidi, GLISSANDO_MIN_MIDI, GLISSANDO_MAX_MIDI, COLORS.USER);
        const lastMidi = pitchHistoryMidi[pitchHistoryMidi.length - 1];
        if (lastMidi != null) {
          const noteName = freqToNoteName(noteNumberToFreq(lastMidi));
          viz.drawCurrentPitchIndicator(lastMidi, GLISSANDO_MIN_MIDI, GLISSANDO_MAX_MIDI, noteName, COLORS.USER);
          viz.drawPitchDot(lastMidi, GLISSANDO_MIN_MIDI, GLISSANDO_MAX_MIDI, animPhase, COLORS.USER);
        }
      } else if (currentMode === 'cruise') {
        // 直线巡航：cents Y 轴 + 目标线 + ±50 cents 边界线（虚线，淡色）
        viz.drawGrid(-100, 100, (v) => (v >= 0 ? '+' : '') + Math.round(v) + '¢');
        viz.drawTargetLine(0, -100, 100, COLORS.TARGET, '目标');
        viz.drawTargetLine(-50, -100, 100, '#475569', '');
        viz.drawTargetLine(50, -100, 100, '#475569', '');
        viz.drawCurve(cruiseHistory, -100, 100, COLORS.USER);
      } else {
        // 共振 / 跟唱：default（会被 renderResonance/renderFollow 覆盖）
        viz.drawGrid(-1200, 1200, (v) => (v >= 0 ? '+' : '') + Math.round(v) + '¢');
        viz.drawCurve(pitchHistory, -1200, 1200, COLORS.USER);
      }
      renderResonance();
      renderFollow();
      // 调谐器读 engine.lastSmoothed（所有模式可用）
      updateTuner(engine && engine.lastSmoothed);
      animPhase += 0.1;
      requestAnimationFrame(renderLoop);
    }
    renderLoop();

    document.getElementById('primary-btn').addEventListener('click', async () => {
      if (currentState === STATE.IDLE) {
        try {
          await engine.start();
          onPrimaryStart();
        } catch (e) {
          handlePermissionError(e);
        }
      } else if (currentState === STATE.RESULT) {
        // 再来一次
        setState(STATE.IDLE);
        onModeChange();
      }
    });

    document.getElementById('secondary-btn').addEventListener('click', () => {
      // 统计本次 session 指标（在 stop 之前，避免丢失状态）
      if (sessionStartMs != null) {
        const durationMs = performance.now() - sessionStartMs;
        const metrics = sessionMetrics[currentMode] || {};
        updateStatsOnSessionEnd(currentMode, metrics, durationMs);
        sessionStartMs = null;
      }
      engine.stop();
      if (resonanceOsc) { try { resonanceOsc.stop(); } catch (e) {} resonanceOsc = null; }
      if (resonanceAudioCtx) { resonanceAudioCtx.close(); resonanceAudioCtx = null; }
      if (followAudioCtx) { followAudioCtx.close(); followAudioCtx = null; }
      setState(STATE.IDLE);
    });

    setupTabs();
    onModeChange();  // 初始化标签
    setupTuner();      // 调谐器 widget
    setupStatsUI();    // 成绩统计模态
    console.log('声音驾驶舱已加载');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
}

function onPrimaryStart() {
  switch (currentMode) {
    case 'glissando': return startGlissando();
    case 'cruise': return startCruise();
    case 'resonance': return startResonance();
    case 'follow': return startFollow();
  }
}

// === SECTION 14: 调谐器 widget ===
// 调谐器对所有模式都工作：计算最近半音的 cents 偏离
let tunerNeedleEl, tunerNoteTextEl, tunerCentsEl, lastTunerNoteName = null;

function setupTuner() {
  tunerNeedleEl = document.getElementById('tuner-needle');
  tunerNoteTextEl = document.getElementById('tuner-note');
  tunerCentsEl = document.getElementById('tuner-cents');
}

// 把 freq 显示为调谐器：音名 + cents 偏离 + needle 位置 + 颜色
function updateTuner(freq) {
  if (!tunerNeedleEl) return;
  if (!freq) {
    tunerNeedleEl.style.left = '50%';
    tunerNeedleEl.className = 'tuner-needle';
    tunerNoteTextEl.textContent = '—';
    tunerCentsEl.textContent = '—';
    lastTunerNoteName = '—';
    return;
  }
  // 找最近半音
  const midi = freqToNoteNumber(freq);
  const nearestMidi = Math.round(midi);
  const cents = (midi - nearestMidi) * 100;
  const noteName = freqToNoteName(freq);
  // needle 位置：-50 cents → 0%，0 → 50%，+50 → 100%
  const clampedCents = Math.max(-50, Math.min(50, cents));
  const left = 50 + (clampedCents / 50) * 50;
  tunerNeedleEl.style.left = left + '%';
  // 颜色：|cents| <= 5 绿，<= 20 黄，否则红
  const abs = Math.abs(cents);
  const cls = abs <= 5 ? 'green' : abs <= 20 ? 'yellow' : 'red';
  tunerNeedleEl.className = 'tuner-needle ' + cls;
  // 音名 + cents 文本
  tunerNoteTextEl.textContent = noteName;
  tunerCentsEl.textContent = (cents >= 0 ? '+' : '') + cents.toFixed(0) + ' cents';
  // 切换音名时闪烁
  if (noteName !== lastTunerNoteName) {
    tunerNoteTextEl.classList.remove('flash');
    // 强制 reflow 重启动画
    void tunerNoteTextEl.offsetWidth;
    tunerNoteTextEl.classList.add('flash');
    lastTunerNoteName = noteName;
  }
}

// === SECTION 15: 成绩统计（localStorage）===

const STATS_KEY = 'voice-cockpit-stats';

function defaultStats() {
  return {
    totalSessions: 0,
    totalDurationMs: 0,
    perMode: {
      glissando: { sessions: 0, bestSmoothness: 0, totalDurationMs: 0 },
      cruise:     { sessions: 0, bestStability: 0,  totalDurationMs: 0 },
      resonance: { sessions: 0, completions: 0,    totalDurationMs: 0 },
      follow:     { sessions: 0, bestAccuracy: 0,   totalDurationMs: 0 },
    },
    lastUpdated: null,
  };
}

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return defaultStats();
    const parsed = JSON.parse(raw);
    // 合并：防止新增字段后旧数据缺字段
    return Object.assign(defaultStats(), parsed, {
      perMode: Object.assign(defaultStats().perMode, parsed.perMode || {}),
    });
  } catch (e) {
    return defaultStats();
  }
}

function saveStats(s) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) { /* localStorage 不可用时静默 */ }
}

// 在 session 结束时调用：根据 mode 累加 session 数、时长、最高分
function updateStatsOnSessionEnd(mode, metrics, durationMs) {
  const s = loadStats();
  s.totalSessions += 1;
  s.totalDurationMs += durationMs;
  s.lastUpdated = new Date().toISOString();
  const m = s.perMode[mode];
  if (!m) { saveStats(s); return; }
  m.sessions += 1;
  m.totalDurationMs = (m.totalDurationMs || 0) + durationMs;
  if (mode === 'glissando' && metrics && typeof metrics.bestSmoothness === 'number') {
    if (metrics.bestSmoothness > (m.bestSmoothness || 0)) m.bestSmoothness = metrics.bestSmoothness;
  } else if (mode === 'cruise' && metrics && typeof metrics.bestStability === 'number') {
    if (metrics.bestStability > (m.bestStability || 0)) m.bestStability = metrics.bestStability;
  } else if (mode === 'resonance' && metrics && metrics.completed) {
    m.completions = (m.completions || 0) + 1;
  } else if (mode === 'follow' && metrics && typeof metrics.bestAccuracy === 'number') {
    if (metrics.bestAccuracy > (m.bestAccuracy || 0)) m.bestAccuracy = metrics.bestAccuracy;
  }
  saveStats(s);
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ' 分 ' + r + ' 秒';
}

function renderStats() {
  const s = loadStats();
  const el = document.getElementById('stats-content');
  const pct = (x) => Math.round((x || 0) * 100) + '%';
  const m = s.perMode;
  el.innerHTML = `
    <h3>总览</h3>
    <div>总练习次数：<strong>${s.totalSessions}</strong> 次</div>
    <div>总练习时长：<strong>${formatDuration(s.totalDurationMs)}</strong></div>
    ${s.lastUpdated ? `<div>最近更新：${new Date(s.lastUpdated).toLocaleString('zh-CN')}</div>` : ''}
    <h3>引擎滑音</h3>
    <div>练习次数：<strong>${m.glissando.sessions}</strong> · 最高平滑度：<strong>${pct(m.glissando.bestSmoothness)}</strong></div>
    <div>累计时长：${formatDuration(m.glissando.totalDurationMs)}</div>
    <h3>直线巡航</h3>
    <div>练习次数：<strong>${m.cruise.sessions}</strong> · 最高稳定度：<strong>${pct(m.cruise.bestStability)}</strong></div>
    <div>累计时长：${formatDuration(m.cruise.totalDurationMs)}</div>
    <h3>共振对齐</h3>
    <div>练习次数：<strong>${m.resonance.sessions}</strong> · 完成次数：<strong>${m.resonance.completions || 0}</strong></div>
    <div>累计时长：${formatDuration(m.resonance.totalDurationMs)}</div>
    <h3>跟唱旋律</h3>
    <div>练习次数：<strong>${m.follow.sessions}</strong> · 最高准确率：<strong>${pct(m.follow.bestAccuracy)}</strong></div>
    <div>累计时长：${formatDuration(m.follow.totalDurationMs)}</div>
  `;
}

function setupStatsUI() {
  const btn = document.getElementById('stats-btn');
  const modal = document.getElementById('stats-modal');
  const closeBtn = document.getElementById('stats-close');
  const resetBtn = document.getElementById('stats-reset');
  if (!btn || !modal) return;
  btn.addEventListener('click', () => {
    renderStats();
    modal.hidden = false;
  });
  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  // 点遮罩关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  resetBtn.addEventListener('click', () => {
    if (confirm('确认要重置所有练习数据吗？')) {
      saveStats(defaultStats());
      renderStats();
    }
  });
}
