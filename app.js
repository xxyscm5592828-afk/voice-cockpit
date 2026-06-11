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

// === SECTION 6: 模式 1 - 引擎滑音 ===

function startGlissando() {
  setState(STATE.RECORDING_GLISSANDO);
  // pitchHistory 已经在 onModeChange 中清空
  const modeReadout = document.getElementById('mode-readout');
  // 实时计算平滑度
  engine.onPitch = (freq) => {
    const cents = freq ? freqToCents(freq, 440) : null;
    pitchHistory.push(cents);
    if (pitchHistory.length > 100) pitchHistory.shift();
    currentNoteEl.textContent = freq ? freqToNoteName(freq) : '—';
    const smoothness = calcSmoothness(pitchHistory.filter(x => x !== null));
    modeReadout.textContent = `平滑度: ${Math.round(smoothness * 100)}%`;
  };
}

// --- 模式 3/4 占位（待 Task 9/10 替换）---
function startResonance() {
  setState(STATE.IDLE);
  showError('共振对齐模式尚未实现（等待 Task 9）');
  engine.stop();
}

function startFollow() {
  setState(STATE.IDLE);
  showError('跟唱模式尚未实现（等待 Task 10）');
  engine.stop();
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
  // 重置可视化
  pitchHistory.length = 0;
  viz.clear();
  currentNoteEl.textContent = '—';
  // 模式标签在 readout 显示
  const labels = { glissando: '引擎滑音', cruise: '直线巡航', resonance: '共振对齐', follow: '跟唱' };
  document.getElementById('mode-readout').textContent = labels[currentMode];
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.hidden = false;
  setTimeout(() => { banner.hidden = true; }, 4000);
}

// === SECTION 12: 初始化 ===

let engine, viz, currentNoteEl, levelFill, pitchHistory;

if (typeof document !== 'undefined') {
  const onReady = () => {
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

    function renderLoop() {
      viz.clear();
      viz.drawGrid(-1200, 1200, (v) => (v >= 0 ? '+' : '') + Math.round(v) + '¢');
      viz.drawCurve(pitchHistory, -1200, 1200, COLORS.USER);
      requestAnimationFrame(renderLoop);
    }
    renderLoop();

    document.getElementById('primary-btn').addEventListener('click', async () => {
      if (currentState === STATE.IDLE) {
        try {
          await engine.start();
          onPrimaryStart();
        } catch (e) {
          showError('麦克风启动失败：' + e.message);
        }
      }
    });

    document.getElementById('secondary-btn').addEventListener('click', () => {
      engine.stop();
      setState(STATE.IDLE);
    });

    setupTabs();
    onModeChange();  // 初始化标签
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
