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
  USER: '#34d399',
  USER_BAD: '#fb7185',
  REFERENCE: '#fbbf24',
  TARGET: '#e6f1ff',
  FUSION: '#fbbf24',
  GRID: 'rgba(120, 180, 220, 0.18)',
  TEXT_DIM: '#7c93ad',
};

// === 课程引导 ===
const COURSE_STEPS = [
  { id: 'ear_training', name: '听觉训练', desc: '先学会听出两个音的差别' },
  { id: 'resonance',    name: '共震齐驱', desc: '发长音，感受参考音靠近时的共鸣感' },
  { id: 'glissando',    name: '引擎滑音', desc: '自由滑音，感受声带松紧变化' },
  { id: 'cruise',       name: '直线巡航', desc: '把音稳稳停在一个目标音上' },
  { id: 'follow',       name: '跟唱旋律', desc: '跟着旋律唱，综合应用' },
];
const PROGRESS_KEY = 'voice-cockpit-progress';

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { completedSteps: [], freePractice: false };
    return JSON.parse(raw);
  } catch (e) {
    return { completedSteps: [], freePractice: false };
  }
}
function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) {}
}

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

// 把音名转成 MIDI 数字（"C4" → 60，"Bb4" → 70）
function noteNameToMidi(name) {
  const m = name.match(/^([A-G])([#b]?)(\d)$/);
  if (!m) return 60;
  let idx = NOTE_NAMES.indexOf(m[1]);
  if (m[2] === '#') idx += 1;
  else if (m[2] === 'b') idx -= 1;
  const octave = parseInt(m[3]);
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

// 帧间八度校正：pitchy 偶发把音高报高/低一个八度（octave error），
// 表现为与上一有效帧差约整八度的单帧跳变——真实发声不可能单帧跨 12 半音。
// 返回 [修正后频率, 新 streak]；连续 3 帧保持翻倍关系则认定真实换八度，接受新值。
function octaveCorrect(pitch, lastPitch, streak) {
  if (lastPitch) {
    const ratio = pitch / lastPitch;
    const up = ratio >= 1.9 && ratio <= 2.15;
    const down = ratio >= 0.465 && ratio <= 0.525;
    if (up || down) {
      if (streak + 1 >= 3) return [pitch, 0];            // 连续 3 帧：真实换八度
      return [down ? pitch * 2 : pitch / 2, streak + 1]; // 单帧跳八度：拉回
    }
  }
  return [pitch, 0];
}

// === Node 导出（仅测试用）===
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    freqToNoteNumber, noteNumberToFreq, freqToNoteName, freqToCents,
    isInTune, calcStability, calcSmoothness, octaveCorrect,
  };
}
export { freqToNoteNumber, noteNumberToFreq, freqToNoteName, freqToCents, isInTune, calcStability, calcSmoothness, octaveCorrect };

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
    this.onWaveform = null;  // (Float32Array 时域样本) => void - 每次 audio frame 调用
    this._timer = null;
    // 中值滤波器，平滑音高曲线（保留原值无 clarity 时仍可用）
    this.pitchFilter = new MedianFilter(3);
    this.lastSmoothed = null;
    // 八度校正状态：上一有效帧频率 + 连续翻倍帧计数（octaveCorrect 用）
    this.lastValidPitch = null;
    this.octaveStreak = 0;
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

    // 实时波形回调（每个 audio frame 一次）
    if (this.onWaveform) this.onWaveform(this.buffer);

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
      const [corrected, streak] = octaveCorrect(pitch, this.lastValidPitch, this.octaveStreak);
      this.lastValidPitch = corrected;
      this.octaveStreak = streak;
      const smoothed = this.pitchFilter.push(corrected);
      this.lastSmoothed = smoothed;
      if (this.onPitch) this.onPitch(smoothed, clarity);
    } else {
      this.pitchFilter.reset();
      this.lastSmoothed = null;
      this.lastValidPitch = null;  // 无效帧（换气/间隙）后重置八度基准，起音帧直接信任
      this.octaveStreak = 0;
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
      showError('🎤 听不清你的声音：请靠近麦克风 2~5 厘米，或调大音量再试');
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
    this.waveformHeight = 60;  // 顶部音频波形区高度
    this.mainTop = 0;          // 主图区顶部 Y（波形区下方）
    this.mainHeight = 0;       // 主图区高度
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
    this.mainTop = this.waveformHeight;
    this.mainHeight = Math.max(0, this.h - this.waveformHeight);
  }

  clear() {
    // 清空为透明，透出 #canvas 的 CSS 渐变背景
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  // MIDI 数字 → canvas Y 坐标（在主图区内）
  midiToY(midi, minMidi, maxMidi) {
    const yNorm = (midi - minMidi) / (maxMidi - minMidi);
    const clamped = Math.max(0, Math.min(1, yNorm));
    return this.mainTop + this.mainHeight - clamped * this.mainHeight;
  }

  // 频率 → canvas Y 坐标（在主图区内）
  freqToY(freq, yMin, yMax) {
    const yNorm = (freq - yMin) / (yMax - yMin);
    const clamped = Math.max(0, Math.min(1, yNorm));
    return this.mainTop + this.mainHeight - clamped * this.mainHeight;
  }

  // 画水平网格 + y 轴刻度标签（仅在主图区）
  drawGrid(yMin, yMax, yFormatter) {
    this.ctx.strokeStyle = COLORS.GRID;
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = COLORS.TEXT_DIM;
    this.ctx.font = '12px sans-serif';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = this.mainTop + (this.mainHeight / 4) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.w, y);
      this.ctx.stroke();
      const yVal = yMax - (yMax - yMin) * (i / 4);
      this.ctx.fillText(yFormatter(yVal), 6, y);
    }
  }

  // 在 y 值处画水平虚线（仅在主图区）
  drawTargetLine(yValue, yMin, yMax, color = COLORS.TARGET, label = '') {
    const yNorm = (yValue - yMin) / (yMax - yMin);
    const y = this.mainTop + this.mainHeight - Math.max(0, Math.min(1, yNorm)) * this.mainHeight;
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

  // 画最近 N 个采样点（仅在主图区）
  drawCurve(samples, yMin, yMax, color = COLORS.USER, lineWidth = 2.5) {
    if (samples.length < 2) return;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      if (samples[i] == null) continue;
      const x = (i / (n - 1)) * this.w;
      const yNorm = (samples[i] - yMin) / (yMax - yMin);
      const y = this.mainTop + this.mainHeight - Math.max(0, Math.min(1, yNorm)) * this.mainHeight;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();
  }

  // 用 MIDI 数字画 Y 轴音名网格（左右两侧都画音名，仅在主图区）
  drawNoteGrid(minNote, maxNote) {
    const minMidi = noteNameToMidi(minNote);
    const maxMidi = noteNameToMidi(maxNote);
    this.ctx.strokeStyle = COLORS.GRID;
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = COLORS.TEXT_DIM;
    this.ctx.font = '12px sans-serif';
    this.ctx.textBaseline = 'middle';
    const sideW = 28;  // 两侧音名标签占的宽度
    for (let m = minMidi; m <= maxMidi; m++) {
      const y = this.midiToY(m, minMidi, maxMidi);
      this.ctx.beginPath();
      this.ctx.moveTo(sideW, y);
      this.ctx.lineTo(this.w - sideW, y);
      this.ctx.stroke();
      // 音名 = C, C#, D, ... B（不带八度）
      const noteName = NOTE_NAMES[((m % 12) + 12) % 12];
      // 左侧
      this.ctx.textAlign = 'left';
      this.ctx.fillText(noteName, 5, y);
      // 右侧
      this.ctx.textAlign = 'right';
      this.ctx.fillText(noteName, this.w - 5, y);
    }
  }

  // 用 MIDI 数字画曲线（仅在主图区）
  drawCurveByMidi(samples, minMidi, maxMidi, color = COLORS.USER, lineWidth = 2.5) {
    if (samples.length < 2) return;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    const n = samples.length;
    const sideW = 28;
    for (let i = 0; i < n; i++) {
      if (samples[i] == null) continue;
      const x = sideW + (i / (n - 1)) * (this.w - 2 * sideW);
      const y = this.midiToY(samples[i], minMidi, maxMidi);
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

  // 在指定位置画一个点（用于标记融合点等，xRatio 0-1, yValue 是频率）
  drawMarker(xRatio, yValue, yMin, yMax, color = COLORS.FUSION, radius = 8) {
    const x = xRatio * this.w;
    const y = this.freqToY(yValue, yMin, yMax);
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

  // 画顶部实时音频波形（绿色时域信号），占据顶部 waveformHeight 区域
  drawWaveform(buffer) {
    const top = 0;
    const h = this.waveformHeight;
    const midY = top + h / 2;
    // 背景
    this.ctx.fillStyle = 'rgba(30, 42, 64, 0.5)';
    this.ctx.fillRect(0, top, this.w, h);
    // 中线
    this.ctx.strokeStyle = COLORS.GRID;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, midY);
    this.ctx.lineTo(this.w, midY);
    this.ctx.stroke();
    // 底部分隔线
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.mainTop);
    this.ctx.lineTo(this.w, this.mainTop);
    this.ctx.stroke();
    // 波形
    if (!buffer || buffer.length === 0) return;
    this.ctx.strokeStyle = COLORS.USER;
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    const n = buffer.length;
    const amp = h / 2 - 4;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * this.w;
      const y = midY - buffer[i] * amp;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();
  }

  // 当前音高球：实心球 + 垂直延伸线 + 大字音名（截图风格）
  drawPitchBall(midi, minMidi, maxMidi, noteName, color = COLORS.REFERENCE) {
    if (midi == null) return;
    const x = this.w - 50;
    const y = this.midiToY(midi, minMidi, maxMidi);
    // 垂直延伸线
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([]);
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x, this.mainTop + this.mainHeight);
    this.ctx.stroke();
    // 球
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, 10, 0, Math.PI * 2);
    this.ctx.fill();
    // 大字音名（球的左侧）
    this.ctx.fillStyle = '#e6f1ff';
    this.ctx.font = 'bold 64px sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(noteName, x - 20, y);
  }

  // 在最近半音位置画水平虚线参考线（比普通网格线更亮）
  drawNearestSemitoneLine(midi, minMidi, maxMidi, color = '#fbbf24') {
    if (midi == null) return;
    const nearestMidi = Math.round(midi);
    const y = this.midiToY(nearestMidi, minMidi, maxMidi);
    const sideW = 28;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(sideW, y);
    this.ctx.lineTo(this.w - sideW, y);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
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

  ode: {
    name: '欢乐颂',
    bpm: 120,
    notes: [
      // Ode to Joy 第一句: E E F G | G F E D | C C D E | E. D D
      { note: 'E4', start: 0.0,  duration: 0.5 },
      { note: 'E4', start: 0.5,  duration: 0.5 },
      { note: 'F4', start: 1.0,  duration: 0.5 },
      { note: 'G4', start: 1.5,  duration: 0.5 },
      { note: 'G4', start: 2.0,  duration: 0.5 },
      { note: 'F4', start: 2.5,  duration: 0.5 },
      { note: 'E4', start: 3.0,  duration: 0.5 },
      { note: 'D4', start: 3.5,  duration: 0.5 },
      { note: 'C4', start: 4.0,  duration: 0.5 },
      { note: 'C4', start: 4.5,  duration: 0.5 },
      { note: 'D4', start: 5.0,  duration: 0.5 },
      { note: 'E4', start: 5.5,  duration: 0.5 },
      { note: 'E4', start: 6.0,  duration: 0.75 },
      { note: 'D4', start: 6.75, duration: 0.25 },
      { note: 'D4', start: 7.0,  duration: 1.0 },
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
  const m = name.match(/^([A-G])([#b]?)(\d)$/);
  if (!m) return 440;
  let idx = NOTE_NAMES.indexOf(m[1]);
  if (m[2] === '#') idx += 1;
  else if (m[2] === 'b') idx -= 1;
  const octave = parseInt(m[3]);
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
    viz.ctx.strokeStyle = COLORS.USER;
    viz.ctx.lineWidth = 2.5;
    viz.ctx.beginPath();
    for (let i = 0; i < userXs.length; i++) {
      const x = userXs[i] * viz.w;
      const y = viz.freqToY(userYs[i], yMin, yMax);
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
      const y = viz.freqToY(refSamples[i + 1], yMin, yMax);
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
let followNoteLock = false;    // 起音容忍：进入在调范围后才开始计分
let followLastNoteKey = null;  // 当前计分音（换音时重置锁定）
let followDevSum = 0;          // 偏差诊断：cents 累计（正=偏高，负=偏低）
let followDevCount = 0;        // 参与偏差统计的帧数
let selectedMelodyKey = 'happy_birthday';  // 当前选择的曲目（切歌后点「开始」生效）

function startFollow() {
  followMelody = MELODIES[selectedMelodyKey] || MELODIES.happy_birthday;
  followSamples = [];
  followOnTarget = 0;
  followTotal = 0;
  followNoteLock = false;
  followLastNoteKey = null;
  followDevSum = 0;
  followDevCount = 0;
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

    // 起音容忍：换音后重置锁定；用户首次进入在调范围（±50¢）才开始计分，
    // 未进入超过 0.8s（宽限期）也强制开始计分，防止一直不唱刷分
    if (target) {
      const noteKey = target.note + '@' + target.start;
      if (noteKey !== followLastNoteKey) { followLastNoteKey = noteKey; followNoteLock = false; }
      if (!followNoteLock) {
        const inRange = freq && targetFreq &&
          Math.abs(1200 * Math.log2(freq / targetFreq)) <= CONFIG.CENTS_THRESHOLD;
        if (inRange || t - target.start > 0.8) followNoteLock = true;
      }
    }

    const inTune = (freq && targetFreq) ? isInTune(freq, targetFreq) : null;
    const counted = inTune !== null && followNoteLock;
    followSamples.push({ t, userFreq: freq, targetFreq, inTune });
    if (counted) {
      followTotal++;
      if (inTune) followOnTarget++;
      followDevSum += 1200 * Math.log2(freq / targetFreq);  // 正=偏高，负=偏低
      followDevCount++;
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
    // 偏差方向诊断：累计足够样本才给出结论，避免误导
    let diag = '';
    if (followDevCount >= 10) {
      const mean = Math.round(followDevSum / followDevCount);
      sessionMetrics.follow.meanDeviationCents = mean;
      if (mean > 5) diag = ` · 平均偏高 ${mean}¢`;
      else if (mean < -5) diag = ` · 平均偏低 ${Math.abs(mean)}¢`;
      else diag = ' · 整体无偏高/偏低';
    }
    document.getElementById('mode-readout').innerHTML = `🎉 准确率: <strong>${acc}%</strong>${diag}`;
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
    const y = viz.freqToY(f, yMin, yMax);
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
    const y1 = viz.freqToY(pts[i - 1].userFreq, yMin, yMax);
    const y2 = viz.freqToY(pts[i].userFreq, yMin, yMax);
    viz.ctx.moveTo(x1, y1);
    viz.ctx.lineTo(x2, y2);
    viz.ctx.stroke();
  }
}

// === SECTION 9.5: 模式 5 - 听觉训练 ===

// 难度等级：cents 差值（100=半音，50=四分之一音，25=八分之一音，10=很难）
const ET_LEVELS = [100, 50, 25, 10];
const ET_QUESTIONS_PER_LEVEL = 10;
const ET_PASS_THRESHOLD = 0.8;  // 80% 答对率升级

let etAudioCtx = null;
let etCurrentLevel = 0;      // 索引到 ET_LEVELS
let etQuestionIndex = 0;     // 0-9
let etCorrectCount = 0;
let etStreak = 0;            // 自适应：连对/连错计数（正=连对，负=连错）
let etCurrentQuestion = null; // { freqA, freqB, isSame, diffCents }

function startEarTraining() {
  etCurrentLevel = 0;
  etQuestionIndex = 0;
  etCorrectCount = 0;
  etStreak = 0;
  etAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  updateEtProgressDisplay();
  document.getElementById('et-instruction').textContent = '听两个音，判断是否相同';
  document.getElementById('et-feedback').textContent = '';
  document.getElementById('et-feedback').className = 'et-feedback';
  nextEtQuestion();
}

function nextEtQuestion() {
  if (etQuestionIndex >= ET_QUESTIONS_PER_LEVEL) {
    // 本级结束
    const accuracy = etCorrectCount / ET_QUESTIONS_PER_LEVEL;
    if (accuracy >= ET_PASS_THRESHOLD && etCurrentLevel < ET_LEVELS.length - 1) {
      etCurrentLevel++;
      etQuestionIndex = 0;
      etCorrectCount = 0;
      showEtFeedback('✓ 通关！进入等级 ' + (etCurrentLevel + 1), true);
      updateEtProgressDisplay();
      // 课程通关检查：达到 Level 2（etCurrentLevel >= 1）
      if (!isFreePractice && currentStepIndex < COURSE_STEPS.length && COURSE_STEPS[currentStepIndex].id === 'ear_training' && etCurrentLevel >= 1) {
        if (!courseProgress.completedSteps.includes('ear_training')) {
          courseProgress.completedSteps.push('ear_training');
          saveProgress(courseProgress);
        }
        // 延迟显示通关弹层，让用户先看到升级反馈
        setTimeout(() => {
          stopEarTraining();
          setState(STATE.IDLE);
          showPassOverlay('听觉训练', false);
        }, 2500);
        return;
      }
      setTimeout(() => nextEtQuestion(), 2000);
      return;
    } else if (accuracy >= ET_PASS_THRESHOLD) {
      // 最高级也通关了
      showEtFeedback('🎉 全部通关！你的听觉已经很敏锐了', true);
      setState(STATE.IDLE);
      return;
    } else {
      // 没达标，重来
      showEtFeedback('正确率 ' + Math.round(accuracy * 100) + '%，再来一轮', false);
      etQuestionIndex = 0;
      etCorrectCount = 0;
      updateEtProgressDisplay();
      setTimeout(() => nextEtQuestion(), 2000);
      return;
    }
  }

  // 生成题目
  etCurrentQuestion = generateEtQuestion();
  setState(STATE.ET_PLAYING);
  document.getElementById('et-instruction').textContent = '听两个音，判断是否相同';
  document.getElementById('et-feedback').textContent = '';
  document.getElementById('et-feedback').className = 'et-feedback';
  // 播放阶段：启用重播按钮，禁用答案按钮
  document.getElementById('et-play-a').disabled = false;
  document.getElementById('et-play-b').disabled = false;
  document.getElementById('et-answer-same').disabled = true;
  document.getElementById('et-answer-diff').disabled = true;

  // 自动播放两个音
  playEtSequence(etCurrentQuestion, () => {
    setState(STATE.ET_ANSWERING);
    document.getElementById('et-instruction').textContent = '它们相同吗？';
    // 答题阶段：启用答案按钮
    document.getElementById('et-answer-same').disabled = false;
    document.getElementById('et-answer-diff').disabled = false;
  });

  updateEtProgressDisplay();
}

function generateEtQuestion() {
  // 随机基准音 C4-C5（MIDI 60-72）
  const baseMidi = 60 + Math.floor(Math.random() * 13);
  const freqA = noteNumberToFreq(baseMidi);
  const diffCents = ET_LEVELS[etCurrentLevel];
  const isSame = Math.random() < 0.5;
  const freqB = isSame ? freqA : freqA * Math.pow(2, diffCents / 1200);
  return { freqA, freqB, isSame, diffCents };
}

// 播放两个音（A 然后 B），每个 1 秒，间隔 0.3 秒
function playEtSequence(question, onDone) {
  const t0 = etAudioCtx.currentTime + 0.1;
  playEtTone(question.freqA, t0, 1.0);
  playEtTone(question.freqB, t0 + 1.3, 1.0);
  if (onDone) setTimeout(onDone, 2700);
}

// 播放单个正弦波音（带包络）
function playEtTone(freq, startTime, duration) {
  const osc = etAudioCtx.createOscillator();
  const gain = etAudioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // ADSR 简化：attack 50ms → sustain → release 100ms
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.3, startTime + 0.05);
  gain.gain.setValueAtTime(0.3, startTime + duration - 0.1);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain);
  gain.connect(etAudioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

// 用户点"听音 A" / "听音 B" 重播
function replayEtTone(which) {
  if (!etCurrentQuestion || !etAudioCtx) return;
  const freq = which === 'A' ? etCurrentQuestion.freqA : etCurrentQuestion.freqB;
  playEtTone(freq, etAudioCtx.currentTime + 0.05, 1.0);
}

// 用户回答
function answerEtQuestion(userSaysSame) {
  if (currentState !== STATE.ET_ANSWERING) return;
  setState(STATE.ET_FEEDBACK);
  const correct = (userSaysSame === etCurrentQuestion.isSame);
  if (correct) etCorrectCount++;
  etStreak = correct ? Math.max(etStreak, 0) + 1 : Math.min(etStreak, 0) - 1;
  const answerText = etCurrentQuestion.isSame ? '相同' : '不同';
  showEtFeedback(
    correct ? `✓ 正确！(${answerText})` : `✗ 答错了，正确答案：${answerText}`,
    correct
  );
  etQuestionIndex++;
  updateEtProgressDisplay();

  // 自适应难度：连对 4 题提前升档，连错 3 题降档（放宽 cents），重置本级进度
  if (etStreak >= 4 && etCurrentLevel < ET_LEVELS.length - 1) {
    etCurrentLevel++;
    etQuestionIndex = 0;
    etCorrectCount = 0;
    etStreak = 0;
    showEtFeedback('🔥 连对 4 题！直接升到等级 ' + (etCurrentLevel + 1), true);
    updateEtProgressDisplay();
    setTimeout(() => nextEtQuestion(), 1800);
    return;
  }
  if (etStreak <= -3 && etCurrentLevel > 0) {
    etCurrentLevel--;
    etQuestionIndex = 0;
    etCorrectCount = 0;
    etStreak = 0;
    showEtFeedback('💪 连错 3 题，先降回等级 ' + (etCurrentLevel + 1) + ' 恢复手感', false);
    updateEtProgressDisplay();
    setTimeout(() => nextEtQuestion(), 1800);
    return;
  }
  setTimeout(() => nextEtQuestion(), 1800);
}

function showEtFeedback(text, isCorrect) {
  const el = document.getElementById('et-feedback');
  el.textContent = text;
  el.className = 'et-feedback ' + (isCorrect ? 'correct' : 'wrong');
}

function updateEtProgressDisplay() {
  document.getElementById('et-level').textContent = etCurrentLevel + 1;
  document.getElementById('et-question').textContent = Math.min(etQuestionIndex + 1, ET_QUESTIONS_PER_LEVEL);
  const total = etQuestionIndex;
  const acc = total > 0 ? Math.round((etCorrectCount / total) * 100) + '%' : '—';
  document.getElementById('et-accuracy').textContent = acc;
}

function stopEarTraining() {
  if (etAudioCtx) { try { etAudioCtx.close(); } catch (e) {} etAudioCtx = null; }
  etCurrentQuestion = null;
  document.getElementById('et-play-a').disabled = true;
  document.getElementById('et-play-b').disabled = true;
  document.getElementById('et-answer-same').disabled = true;
  document.getElementById('et-answer-diff').disabled = true;
  document.getElementById('et-instruction').textContent = '点击「开始」启动听觉训练';
}

// === SECTION 9.6: 即时纠错反馈 ===

let lastFeedbackTime = 0;
const FEEDBACK_INTERVAL = 500;  // ms 防抖

function updateFeedback() {
  if (currentMode === 'ear_training') return;  // 听觉训练不需要
  const now = performance.now();
  if (now - lastFeedbackTime < FEEDBACK_INTERVAL) return;
  lastFeedbackTime = now;

  const bar = document.getElementById('feedback-bar');
  if (!bar) return;
  let text = '', cls = '';

  if (currentMode === 'cruise' && currentState === STATE.RECORDING_STABLE) {
    // 直线巡航：基于 cents 偏离
    const recent = cruiseHistory.slice(-5);
    if (recent.length > 0) {
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const abs = Math.abs(avg);
      if (abs < 15) { text = '✓ 准了！保持'; cls = 'good'; }
      else if (avg > 15) { text = '↓ 高了，往下一点'; cls = 'warn'; }
      else { text = '↑ 低了，往上一点'; cls = 'warn'; }
    }
  } else if (currentMode === 'glissando' && currentState === STATE.RECORDING_GLISSANDO) {
    // 引擎滑音：检测是否在动
    const recent = pitchHistoryMidi.slice(-10);
    if (recent.length >= 5) {
      const range = Math.max(...recent) - Math.min(...recent);
      if (range < 0.5) { text = '继续滑动，不要停'; cls = 'warn'; }
      else { text = '很好，保持滑动'; cls = 'good'; }
    }
  } else if (currentMode === 'resonance') {
    if (currentState === STATE.LISTENING) { text = '发一个稳定的「啊」'; cls = ''; }
    else if (currentState === STATE.LOCKED || currentState === STATE.PLAYING) { text = '保持长音，感受参考音靠近'; cls = ''; }
    else if (currentState === STATE.FUSED) { text = '✓ 感受共鸣！两个音重合了'; cls = 'good'; }
  } else if (currentMode === 'follow' && currentState === STATE.SINGING) {
    // 跟唱：基于当前音偏离
    if (followSamples.length > 0) {
      const last = followSamples[followSamples.length - 1];
      if (last && last.userFreq && last.targetFreq) {
        const cents = 1200 * Math.log2(last.userFreq / last.targetFreq);
        const abs = Math.abs(cents);
        if (abs < 20) { text = '✓ 准'; cls = 'good'; }
        else if (cents > 20) { text = '↓ 高了'; cls = 'warn'; }
        else { text = '↑ 低了'; cls = 'warn'; }
      }
    }
  }

  if (text) {
    bar.textContent = text;
    bar.className = 'feedback-bar ' + cls;
    bar.hidden = false;
  } else {
    bar.hidden = true;
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
  EAR_TRAINING: 'EAR_TRAINING',    // 听觉训练
  ET_PLAYING: 'ET_PLAYING',        // 听觉训练：播放中
  ET_ANSWERING: 'ET_ANSWERING',    // 听觉训练：等待回答
  ET_FEEDBACK: 'ET_FEEDBACK',      // 听觉训练：显示反馈
};

let currentState = STATE.IDLE;
let currentMode = 'glissando';  // glissando | cruise | resonance | follow | ear_training

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
    case STATE.EAR_TRAINING:
    case STATE.ET_PLAYING:
    case STATE.ET_ANSWERING:
      primary.hidden = true;
      secondary.hidden = false;
      secondary.textContent = '结束训练';
      break;
    case STATE.ET_FEEDBACK:
      primary.hidden = true;
      secondary.hidden = false;
      secondary.textContent = '结束训练';
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
  const labels = {
    glissando: '引擎滑音',
    cruise: '直线巡航',
    resonance: '共震齐驱',
    follow: '跟唱',
    ear_training: '听觉训练',
  };
  document.getElementById('mode-readout').textContent = labels[currentMode];
  // 清掉 error banner
  document.getElementById('error-banner').hidden = true;

  // 切换 canvas / 听觉训练面板的显示
  const canvas = document.getElementById('canvas');
  const etPanel = document.getElementById('ear-training-panel');
  const feedbackBar = document.getElementById('feedback-bar');
  const tuner = document.getElementById('tuner');
  if (currentMode === 'ear_training') {
    canvas.hidden = true;
    etPanel.hidden = false;
    feedbackBar.hidden = true;
    tuner.hidden = true;
  } else {
    canvas.hidden = false;
    etPanel.hidden = true;
    feedbackBar.hidden = false;
    tuner.hidden = false;
  }
}

// === 课程引导：步骤切换 / 自由练习 tab / 通关检查 / 通关弹层 ===
function showCurrentStep() {
  pitchHistory.length = 0;
  pitchHistoryMidi.length = 0;
  cruiseHistory = [];
  viz.clear();
  currentNoteEl.textContent = '—';
  document.getElementById('error-banner').hidden = true;

  // 更新进度条
  const fill = document.getElementById('course-progress-fill');
  const text = document.getElementById('course-progress-text');
  const titleEl = document.getElementById('course-step-title');
  const descEl = document.getElementById('course-step-desc');
  const courseBar = document.getElementById('course-bar');

  if (isFreePractice) {
    // 自由练习模式：隐藏课程条，显示自由 tab
    courseBar.hidden = true;
    showFreePracticeTabs();
    currentMode = 'glissando';  // 默认
  } else {
    courseBar.hidden = false;
    hideFreePracticeTabs();
    const step = COURSE_STEPS[currentStepIndex];
    currentMode = step.id;
    const completed = courseProgress.completedSteps.length;
    fill.style.width = (completed / COURSE_STEPS.length * 100) + '%';
    text.textContent = `第 ${currentStepIndex + 1} 关 / 共 ${COURSE_STEPS.length} 关`;
    titleEl.textContent = `第 ${currentStepIndex + 1} 关：${step.name}`;
    descEl.textContent = step.desc;
    renderCourseStepsList();
  }

  // 切换 canvas / 听觉训练面板
  const canvas = document.getElementById('canvas');
  const etPanel = document.getElementById('ear-training-panel');
  const feedbackBar = document.getElementById('feedback-bar');
  const tuner = document.getElementById('tuner');
  if (currentMode === 'ear_training') {
    canvas.hidden = true;
    etPanel.hidden = false;
    feedbackBar.hidden = true;
    tuner.hidden = true;
  } else {
    canvas.hidden = false;
    etPanel.hidden = true;
    feedbackBar.hidden = false;
    tuner.hidden = false;
  }

  ensureMelodyTabs();
}

// 跟唱模式曲目切换按钮组（动态创建，仅跟唱模式显示）
function ensureMelodyTabs() {
  let tabs = document.getElementById('melody-tabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'melody-tabs';
    tabs.className = 'free-practice-tabs melody-tabs';
    Object.entries(MELODIES).forEach(([key, mel]) => {
      const btn = document.createElement('button');
      btn.className = 'tab' + (key === selectedMelodyKey ? ' active' : '');
      btn.textContent = '🎼 ' + mel.name;
      btn.addEventListener('click', () => {
        if (currentState !== STATE.IDLE) {
          showError('请先停止当前练习再换曲目');
          return;
        }
        selectedMelodyKey = key;
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
      });
      tabs.appendChild(btn);
    });
    const dash = document.querySelector('.dashboard');
    dash.insertBefore(tabs, document.getElementById('canvas'));
  }
  tabs.hidden = currentMode !== 'follow';
}

function showFreePracticeTabs() {
  let tabs = document.getElementById('free-practice-tabs');
  if (!tabs) {
    tabs = document.createElement('nav');
    tabs.id = 'free-practice-tabs';
    tabs.className = 'free-practice-tabs';
    const header = document.querySelector('.app-header');
    header.after(tabs);
    COURSE_STEPS.forEach((step, i) => {
      const btn = document.createElement('button');
      btn.className = 'tab' + (i === 0 ? ' active' : '');
      btn.dataset.mode = step.id;
      btn.textContent = step.name;
      btn.addEventListener('click', () => {
        if (currentState !== STATE.IDLE) {
          showError('请先停止当前练习再切换模式');
          return;
        }
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        currentMode = step.id;
        // 清空画布
        pitchHistory.length = 0;
        pitchHistoryMidi.length = 0;
        cruiseHistory = [];
        viz.clear();
        currentNoteEl.textContent = '—';
        // 切换面板
        const canvas = document.getElementById('canvas');
        const etPanel = document.getElementById('ear-training-panel');
        const feedbackBar = document.getElementById('feedback-bar');
        const tuner = document.getElementById('tuner');
        if (step.id === 'ear_training') {
          canvas.hidden = true; etPanel.hidden = false; feedbackBar.hidden = true; tuner.hidden = true;
        } else {
          canvas.hidden = false; etPanel.hidden = true; feedbackBar.hidden = false; tuner.hidden = false;
        }
        ensureMelodyTabs();
      });
      tabs.appendChild(btn);
    });
  }
  tabs.hidden = false;
}
function hideFreePracticeTabs() {
  const tabs = document.getElementById('free-practice-tabs');
  if (tabs) tabs.hidden = true;
}

// 关卡总览：列出全部关卡名，标记当前关与已通关
function renderCourseStepsList() {
  const list = document.getElementById('course-steps-list');
  if (!list) return;
  list.innerHTML = '';
  COURSE_STEPS.forEach((step, i) => {
    const chip = document.createElement('span');
    chip.className = 'course-step-chip'
      + (courseProgress.completedSteps.includes(step.id) ? ' done' : '')
      + (i === currentStepIndex ? ' active' : '');
    chip.textContent = `${i + 1}. ${step.name}`;
    list.appendChild(chip);
  });
}

function checkStepPassed(mode, metrics) {
  if (isFreePractice) return false;
  const stepId = COURSE_STEPS[currentStepIndex].id;
  if (mode !== stepId) return false;
  switch (mode) {
    case 'ear_training':
      return etCurrentLevel >= 1;  // 达到 Level 2
    case 'resonance':
      return metrics && metrics.completed === true;
    case 'glissando':
      return metrics && typeof metrics.bestSmoothness === 'number' && metrics.bestSmoothness >= 0.6;
    case 'cruise':
      return metrics && typeof metrics.bestStability === 'number' && metrics.bestStability >= 0.8;
    case 'follow':
      return metrics && typeof metrics.bestAccuracy === 'number' && metrics.bestAccuracy >= 0.6;
    default:
      return false;
  }
}

// 通关琶音：C5-E5-G5-C6 上行四音，短促明亮
function playPassArpeggio() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const t0 = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.55);
    });
    setTimeout(() => { try { ctx.close(); } catch (e) {} }, 1500);
  } catch (e) { /* 音效失败不影响通关流程 */ }
}

function showPassOverlay(stepName, isLast) {
  const overlay = document.createElement('div');
  overlay.className = 'pass-overlay';
  overlay.id = 'pass-overlay';
  overlay.innerHTML = `
    <div class="pass-card">
      <div class="pass-icon">${isLast ? '🎓' : '🎉'}</div>
      <h3>${isLast ? '全部课程毕业！' : stepName + ' 通关！'}</h3>
      <p>${isLast
        ? '五关课程全部完成！进入自由练习模式，随时可从上方标签回关复习'
        : '下一步已解锁'}</p>
      <button id="pass-continue-btn">${isLast ? '🎓 进入自由练习' : '继续'}</button>
    </div>
  `;
  document.body.appendChild(overlay);
  playPassArpeggio();
  document.getElementById('pass-continue-btn').addEventListener('click', () => {
    overlay.remove();
    if (isLast) {
      isFreePractice = true;
      showCurrentStep();
    } else {
      currentStepIndex++;
      showCurrentStep();
    }
  });
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.hidden = false;
  setTimeout(() => { banner.hidden = true; }, 4000);
}

// === SECTION 12: 初始化 ===

// 调谐器 widget 变量（用 var 避免 TDZ：在 onReady 内 renderLoop 启动时 tunerNeedleEl 还未初始化）
var tunerNeedleEl, tunerNoteTextEl, tunerCentsEl, lastTunerNoteName = null;

let engine, viz, currentNoteEl, levelFill, pitchHistory;

// 动画相位：每帧递增，给 drawPitchDot 脉冲用
let animPhase = 0;

// 课程引导状态
let courseProgress = loadProgress();
let currentStepIndex = 0;  // 当前课程步骤索引
let isFreePractice = false;  // 是否自由练习模式

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
      // 顶部实时音频波形（所有模式通用）
      viz.drawWaveform(engine.buffer);
      if (currentMode === 'glissando') {
        // 引擎滑音：音名 Y 轴 + MIDI 曲线 + 最近半音参考线 + 音高球
        viz.drawNoteGrid('C4', 'C5');
        viz.drawCurveByMidi(pitchHistoryMidi, GLISSANDO_MIN_MIDI, GLISSANDO_MAX_MIDI, COLORS.USER);
        const lastMidi = pitchHistoryMidi[pitchHistoryMidi.length - 1];
        if (lastMidi != null) {
          const noteName = freqToNoteName(noteNumberToFreq(lastMidi));
          viz.drawNearestSemitoneLine(lastMidi, GLISSANDO_MIN_MIDI, GLISSANDO_MAX_MIDI);
          viz.drawPitchBall(lastMidi, GLISSANDO_MIN_MIDI, GLISSANDO_MAX_MIDI, noteName, COLORS.REFERENCE);
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
      // 即时纠错反馈（500ms 防抖）
      updateFeedback();
      // 调谐器读 engine.lastSmoothed（所有模式可用）
      updateTuner(engine && engine.lastSmoothed);
      animPhase += 0.1;
      requestAnimationFrame(renderLoop);
    }
    renderLoop();

    document.getElementById('primary-btn').addEventListener('click', async () => {
      if (currentState === STATE.IDLE) {
        if (currentMode === 'ear_training') {
          // 听觉训练不需要麦克风
          onPrimaryStart();
        } else {
          try {
            await engine.start();
            onPrimaryStart();
          } catch (e) {
            handlePermissionError(e);
          }
        }
      } else if (currentState === STATE.RESULT) {
        // 再来一次
        setState(STATE.IDLE);
        showCurrentStep();
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
      // 通关检查（在停止引擎前检查，因为 etCurrentLevel 会在 stopEarTraining 中被重置）
      let passed = false;
      if (!isFreePractice) {
        const stepId = COURSE_STEPS[currentStepIndex].id;
        if (currentMode === stepId) {
          const metrics = sessionMetrics[currentMode] || {};
          passed = checkStepPassed(currentMode, metrics);
          if (passed) {
            if (!courseProgress.completedSteps.includes(stepId)) {
              courseProgress.completedSteps.push(stepId);
              saveProgress(courseProgress);
            }
          }
        }
      }
      // 停止引擎
      if (currentMode === 'ear_training') {
        stopEarTraining();
      } else {
        engine.stop();
      }
      if (resonanceOsc) { try { resonanceOsc.stop(); } catch (e) {} resonanceOsc = null; }
      if (resonanceAudioCtx) { resonanceAudioCtx.close(); resonanceAudioCtx = null; }
      if (followAudioCtx) { followAudioCtx.close(); followAudioCtx = null; }
      setState(STATE.IDLE);
      // 通关弹层
      if (passed) {
        const isLast = currentStepIndex === COURSE_STEPS.length - 1;
        showPassOverlay(COURSE_STEPS[currentStepIndex].name, isLast);
      }
    });

    // 听觉训练按钮事件
    document.getElementById('et-play-a').addEventListener('click', () => replayEtTone('A'));
    document.getElementById('et-play-b').addEventListener('click', () => replayEtTone('B'));
    document.getElementById('et-answer-same').addEventListener('click', () => answerEtQuestion(true));
    document.getElementById('et-answer-diff').addEventListener('click', () => answerEtQuestion(false));

    // 初始化课程
    currentStepIndex = 0;
    isFreePractice = courseProgress.completedSteps.length >= COURSE_STEPS.length;
    if (isFreePractice) {
      // 全部通关，直接进自由练习
      showCurrentStep();
    } else {
      // 找到第一个未完成的步骤
      for (let i = 0; i < COURSE_STEPS.length; i++) {
        if (!courseProgress.completedSteps.includes(COURSE_STEPS[i].id)) {
          currentStepIndex = i;
          break;
        }
      }
      showCurrentStep();
    }
    setupTuner();      // 调谐器 widget
    setupStatsUI();    // 成绩统计模态
    setupGuideModal(); // 使用指引弹窗
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
    case 'ear_training': return startEarTraining();
  }
}

// === SECTION 14: 调谐器 widget ===
// 调谐器对所有模式都工作：计算最近半音的 cents 偏离
// (let tunerNeedleEl, tunerNoteTextEl, tunerCentsEl, lastTunerNoteName 已在 SECTION 12 顶部声明)

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
      follow:     { sessions: 0, bestAccuracy: 0,   totalDurationMs: 0, deviationSumCents: 0, deviationSamples: 0 },
    },
    history: [],   // 进步曲线：[{ date, mode, value }]，封顶 60 条
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
      history: Array.isArray(parsed.history) ? parsed.history : [],
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
    // 累计偏差诊断（正=偏高，负=偏低）
    if (typeof metrics.meanDeviationCents === 'number') {
      m.deviationSumCents = (m.deviationSumCents || 0) + metrics.meanDeviationCents;
      m.deviationSamples = (m.deviationSamples || 0) + 1;
    }
  }
  // 进步曲线：记录本次成绩（0-1），封顶 60 条
  if (metrics) {
    let value = null;
    if (mode === 'follow' && typeof metrics.bestAccuracy === 'number') value = metrics.bestAccuracy;
    else if (mode === 'glissando' && typeof metrics.bestSmoothness === 'number') value = metrics.bestSmoothness;
    else if (mode === 'cruise' && typeof metrics.bestStability === 'number') value = metrics.bestStability;
    if (value !== null) {
      s.history = (s.history || []);
      s.history.push({ date: s.lastUpdated, mode, value });
      if (s.history.length > 60) s.history = s.history.slice(-60);
    }
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

// 偏差倾向诊断文案：meanCents 为多次练习的平均偏差（正=偏高，负=偏低）
function followDiagnosisHtml(meanCents) {
  const v = Math.round(meanCents);
  if (v > 5) {
    return `<div class="stat-diag">🎯 音准倾向：整体<strong>偏高 ${v}¢</strong>——放松喉部，别去“够”音高，可多练「直线巡航」</div>`;
  }
  if (v < -5) {
    return `<div class="stat-diag">🎯 音准倾向：整体<strong>偏低 ${Math.abs(v)}¢</strong>——加强气息支撑，可多练「直线巡航」</div>`;
  }
  return '<div class="stat-diag">🎯 音准倾向：无明显偏高/偏低，保持住</div>';
}

// 进步趋势 HTML：最近 10 条混合条形图 + 本周/上周环比
function trendHtml(history) {
  if (!history || history.length === 0) {
    return '<h3>最近趋势</h3><div class="trend-empty">完成一次滑音/巡航/跟唱后，这里会出现你的进步曲线</div>';
  }
  const modeShort = { glissando: '滑', cruise: '巡', follow: '唱' };
  const modeName = { glissando: '引擎滑音', cruise: '直线巡航', follow: '跟唱旋律' };
  const recent = history.slice(-10);
  const bars = recent.map(h => {
    const v = Math.max(0, Math.min(1, h.value)) * 100;
    const d = new Date(h.date);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
    return `<div class="trend-col" title="${dateStr} ${modeName[h.mode] || h.mode} ${Math.round(v)}%">
      <div class="trend-bar"><div class="trend-bar-fill" style="height:${v}%"></div></div>
      <span class="trend-col-label">${modeShort[h.mode] || '?'}</span>
    </div>`;
  }).join('');
  // 环比：本周（近7天）均值 vs 上周（7-14天前）均值
  const now = Date.now();
  const inRange = (h, from, to) => { const age = now - new Date(h.date).getTime(); return age >= from && age < to; };
  const week = history.filter(h => inRange(h, 0, 7 * 864e5));
  const prevWeek = history.filter(h => inRange(h, 7 * 864e5, 14 * 864e5));
  let deltaText = '';
  if (week.length && prevWeek.length) {
    const cur = week.reduce((a, h) => a + h.value, 0) / week.length;
    const prev = prevWeek.reduce((a, h) => a + h.value, 0) / prevWeek.length;
    const delta = Math.round((cur - prev) * 100);
    if (delta > 0) deltaText = `<div class="trend-delta">本周平均 <strong>${Math.round(cur * 100)}%</strong> · 比上周 <strong class="trend-up">↑${delta}%</strong></div>`;
    else if (delta < 0) deltaText = `<div class="trend-delta">本周平均 <strong>${Math.round(cur * 100)}%</strong> · 比上周 <strong class="trend-down">↓${-delta}%</strong></div>`;
    else deltaText = `<div class="trend-delta">本周平均 <strong>${Math.round(cur * 100)}%</strong> · 与上周持平</div>`;
  } else if (week.length) {
    deltaText = `<div class="trend-delta">本周平均 <strong>${Math.round(week.reduce((a, h) => a + h.value, 0) / week.length * 100)}%</strong></div>`;
  }
  return `<h3>最近趋势</h3>${deltaText}<div class="trend-chart">${bars}</div>`;
}

function renderStats() {
  const s = loadStats();
  const el = document.getElementById('stats-content');
  const pct = (x) => Math.round((x || 0) * 100) + '%';
  const m = s.perMode;
  el.innerHTML = `
    ${trendHtml(s.history)}
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
    <h3>共震齐驱</h3>
    <div>练习次数：<strong>${m.resonance.sessions}</strong> · 完成次数：<strong>${m.resonance.completions || 0}</strong></div>
    <div>累计时长：${formatDuration(m.resonance.totalDurationMs)}</div>
    <h3>跟唱旋律</h3>
    <div>练习次数：<strong>${m.follow.sessions}</strong> · 最高准确率：<strong>${pct(m.follow.bestAccuracy)}</strong></div>
    <div>累计时长：${formatDuration(m.follow.totalDurationMs)}</div>
    ${m.follow.deviationSamples ? followDiagnosisHtml(m.follow.deviationSumCents / m.follow.deviationSamples) : ''}
  `;
}

function setupStatsUI() {
  const btn = document.getElementById('stats-btn');
  const modal = document.getElementById('stats-modal');
  const closeBtn = document.getElementById('stats-close');
  const resetBtn = document.getElementById('stats-reset');
  if (!btn || !modal || !closeBtn) {
    console.warn('stats-ui 元素缺失', { btn, modal, closeBtn, resetBtn });
    return;
  }
  function closeModal() { modal.hidden = true; }
  function openModal() {
    renderStats();
    modal.hidden = false;
  }
  btn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeModal();
  });
  // 点遮罩关闭（modal 自身，不是 .stats-modal-content）
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('确认要重置所有练习数据吗？')) {
        saveStats(defaultStats());
        renderStats();
      }
    });
  }
  // 导出数据：下载 JSON 备份（进度 + 统计）
  const exportBtn = document.getElementById('stats-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        progress: courseProgress,
        stats: loadStats(),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'voice-cockpit-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  // 导入数据：校验后写回 localStorage 并刷新页面（保证进度条/自由模式状态一致）
  const importBtn = document.getElementById('stats-import');
  const importFile = document.getElementById('stats-import-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', (e) => { e.stopPropagation(); importFile.click(); });
    importFile.addEventListener('change', () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data || typeof data !== 'object' || !data.stats || typeof data.stats !== 'object') {
            throw new Error('missing stats');
          }
          if (data.progress) saveProgress(data.progress);
          saveStats(Object.assign(defaultStats(), data.stats));
          location.reload();
        } catch (err) {
          showError('导入失败：不是有效的备份数据');
        }
      };
      reader.readAsText(file);
    });
  }
}

// === 使用指引弹窗 ===
function setupGuideModal() {
  const modal = document.getElementById('guide-modal');
  const btn = document.getElementById('guide-start-btn');
  if (modal && btn) {
    btn.addEventListener('click', () => { modal.hidden = true; });
  }
}
