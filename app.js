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

function startFollow() {
  setState(STATE.IDLE);
  showError('跟唱模式尚未实现（等待 Task 10）');
  engine.stop();
}

// === SECTION 7: 模式 2 - 直线巡航 ===

let cruiseTargetFreq = 440;  // 默认 A4
let cruiseHistory = [];      // cents 偏离历史（最近 2 秒 = 40 帧）

function startCruise() {
  setState(STATE.RECORDING_STABLE);
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
      renderResonance();
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
      if (resonanceOsc) {
        try { resonanceOsc.stop(); } catch (e) {}
        resonanceOsc = null;
      }
      if (resonanceAudioCtx) {
        resonanceAudioCtx.close();
        resonanceAudioCtx = null;
      }
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
