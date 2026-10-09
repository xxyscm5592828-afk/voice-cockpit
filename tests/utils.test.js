import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  freqToNoteNumber, noteNumberToFreq, freqToNoteName, freqToCents,
  isInTune, calcStability, calcSmoothness, octaveCorrect,
} from '../app.js';

test('freqToNoteNumber: A4=440 → 69', () => {
  assert.equal(freqToNoteNumber(440), 69);
});

test('freqToNoteNumber: A5=880 → 81', () => {
  assert.equal(freqToNoteNumber(880), 81);
});

test('noteNumberToFreq: 69 → 440', () => {
  assert.equal(noteNumberToFreq(69), 440);
});

test('noteNumberToFreq 与 freqToNoteNumber 互逆', () => {
  for (const f of [220, 261.63, 440, 523.25, 880]) {
    const n = freqToNoteNumber(f);
    assert.ok(Math.abs(noteNumberToFreq(n) - f) < 0.01);
  }
});

test('freqToNoteName: 440 → A4', () => {
  assert.equal(freqToNoteName(440), 'A4');
});

test('freqToNoteName: 261.63 → C4', () => {
  assert.equal(freqToNoteName(261.63), 'C4');
});

test('freqToNoteName: 880 → A5', () => {
  assert.equal(freqToNoteName(880), 'A5');
});

test('freqToCents: 880 vs 440 → 1200', () => {
  assert.equal(freqToCents(880, 440), 1200);
});

test('freqToCents: 466.16 vs 440 → ~100 (Bb4 vs A4)', () => {
  // Bb4 = 466.16Hz，约比 A4 高 100 cents
  const cents = freqToCents(466.16, 440);
  assert.ok(Math.abs(cents - 100) < 1, `expected ~100, got ${cents}`);
});

test('freqToCents: 相同频率 → 0', () => {
  assert.equal(freqToCents(440, 440), 0);
});

test('isInTune: 在 50 cents 内 → true', () => {
  assert.equal(isInTune(440 * Math.pow(2, 30 / 1200), 440), true);  // +30 cents
  assert.equal(isInTune(440 * Math.pow(2, -45 / 1200), 440), true); // -45 cents
});

test('isInTune: 超过 50 cents → false', () => {
  assert.equal(isInTune(440 * Math.pow(2, 60 / 1200), 440), false);  // +60 cents
});

test('calcStability: 全相同 → 1.0', () => {
  assert.equal(calcStability([0, 0, 0, 0, 0]), 1);
});

test('calcStability: 变化大 → 接近 0', () => {
  const result = calcStability([-100, 100, -100, 100, -100]);
  assert.ok(result < 0.5, `expected < 0.5, got ${result}`);
});

test('calcStability: 数据不足 → 0', () => {
  assert.equal(calcStability([]), 0);
  assert.equal(calcStability([5]), 0);
});

test('calcSmoothness: 平滑曲线 → 接近 1', () => {
  const smooth = [100, 102, 104, 103, 105, 107, 106, 108];
  const result = calcSmoothness(smooth);
  assert.ok(result > 0.9, `expected > 0.9, got ${result}`);
});

test('calcSmoothness: 锯齿 → 接近 0', () => {
  const jagged = [100, 200, 100, 200, 100, 200, 100, 200];
  const result = calcSmoothness(jagged);
  assert.ok(result < 0.5, `expected < 0.5, got ${result}`);
});

test('octaveCorrect: 首帧无基准 → 原样返回', () => {
  assert.deepEqual(octaveCorrect(440, null, 0), [440, 0]);
});

test('octaveCorrect: 单帧跳高八度 → 拉回', () => {
  assert.deepEqual(octaveCorrect(880, 440, 0), [440, 1]);
});

test('octaveCorrect: 单帧跳低八度 → 拉回', () => {
  assert.deepEqual(octaveCorrect(220, 440, 0), [440, 1]);
});

test('octaveCorrect: 正常音高变化 → 不修正', () => {
  assert.deepEqual(octaveCorrect(494, 440, 0), [494, 0]);  // 纯四度以内
  assert.deepEqual(octaveCorrect(415.3, 440, 0), [415.3, 0]); // 半音级小偏差
});

test('octaveCorrect: 连续 3 帧翻倍 → 认定真实换八度', () => {
  const [, streak1] = octaveCorrect(880, 440, 0);
  const [, streak2] = octaveCorrect(880, 440, streak1);
  assert.deepEqual(octaveCorrect(880, 440, streak2), [880, 0]);
});

test('octaveCorrect: 边界附近小音程不被误判', () => {
  // 真实音程：倍频程附近但不是整八度（如 +900 cents ≈ 1.68 倍、-900 ≈ 0.59 倍）
  const up900 = 440 * Math.pow(2, 900 / 1200);
  const down900 = 440 * Math.pow(2, -900 / 1200);
  assert.deepEqual(octaveCorrect(up900, 440, 0), [up900, 0]);
  assert.deepEqual(octaveCorrect(down900, 440, 0), [down900, 0]);
});
