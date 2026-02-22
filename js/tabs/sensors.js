/**
 * @file tabs/sensors.js
 * @brief Sensors tab — numeric readouts + scrolling canvas graphs
 *
 * Sub-tab toggle: Graph (default) shows scrolling oscilloscope-style canvas
 * with fixed selectable Y-scale and live value readouts. Values sub-tab shows
 * static numeric readouts. Ring buffers accumulate data in both modes.
 */

import { MSP, readS16 } from '../msp.js';
import { setText } from '../util.js';

// --- Constants ---

const MAX_SAMPLES = 300;
const COLORS = { x: '#f1453d', y: '#59aa29', z: '#2b98f0' };
const GRID_COLOR = 'rgba(255, 255, 255, 0.25)';
const AXIS_COLOR = 'rgba(255, 255, 255, 0.3)';
const LABEL_COLOR = 'rgba(255, 255, 255, 0.4)';
const Y_MARGIN = 40;  // left margin for Y-axis labels

// --- Sample counter (for scrolling grid) ---
let sampleCount = 0;

// --- Ring buffers (always accumulating) ---

const graphData = {
  acc:  { x: [], y: [], z: [] },
  gyro: { x: [], y: [], z: [] },
  mag:  { x: [], y: [], z: [] },
};

// --- Latest values (for graph sidebar readout) ---

const latest = {
  acc:  { x: 0, y: 0, z: 0 },
  gyro: { x: 0, y: 0, z: 0 },
  mag:  { x: 0, y: 0, z: 0 },
};

// --- Sub-tab state ---

let graphMode = true;
let initialized = false;

/** Handle incoming MSP_RAW_IMU messages */
export function handleSensorsMessage(msg) {
  if (msg.cmd !== MSP.RAW_IMU) return;

  // Parse values
  const acc  = { x: readS16(msg.payload, 0) / 512, y: readS16(msg.payload, 2) / 512, z: readS16(msg.payload, 4) / 512 };
  const gyro = { x: readS16(msg.payload, 6), y: readS16(msg.payload, 8), z: readS16(msg.payload, 10) };
  const mag  = { x: readS16(msg.payload, 12), y: readS16(msg.payload, 14), z: readS16(msg.payload, 16) };

  // Update numeric text (always, for Values view)
  setText('imu-acc-x', acc.x.toFixed(2));
  setText('imu-acc-y', acc.y.toFixed(2));
  setText('imu-acc-z', acc.z.toFixed(2));
  setText('imu-gyro-x', gyro.x);
  setText('imu-gyro-y', gyro.y);
  setText('imu-gyro-z', gyro.z);
  setText('imu-mag-x', mag.x);
  setText('imu-mag-y', mag.y);
  setText('imu-mag-z', mag.z);

  // Store latest + push to ring buffers
  Object.assign(latest.acc, acc);
  Object.assign(latest.gyro, gyro);
  Object.assign(latest.mag, mag);
  pushSample(graphData.acc, acc);
  pushSample(graphData.gyro, gyro);
  pushSample(graphData.mag, mag);
  sampleCount++;

  // Redraw graphs if visible
  if (graphMode) redrawAll();
}

function pushSample(buf, sample) {
  buf.x.push(sample.x);
  buf.y.push(sample.y);
  buf.z.push(sample.z);
  if (buf.x.length > MAX_SAMPLES) {
    buf.x.shift();
    buf.y.shift();
    buf.z.shift();
  }
}

// --- Sub-tab switching ---

function initSubtabs() {
  if (initialized) return;
  initialized = true;

  document.querySelectorAll('.sensor-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      graphMode = (view === 'graphs');

      document.querySelectorAll('.sensor-subtab').forEach(b =>
        b.classList.toggle('active', b.dataset.view === view));

      document.getElementById('sensors-graphs').classList.toggle('hidden', !graphMode);
      document.getElementById('sensors-values').classList.toggle('hidden', graphMode);

      if (graphMode) redrawAll();
    });
  });

  // Redraw on scale change
  document.querySelectorAll('.graph-scale-select').forEach(sel => {
    sel.addEventListener('change', () => redrawAll());
  });
}

// Lazy-init on first message
function ensureInit() {
  if (!initialized) initSubtabs();
}

// --- Get selected scale for a graph ---

function getScale(name) {
  const sel = document.getElementById('scale-' + name);
  return sel ? parseFloat(sel.value) : 1;
}

// --- Canvas rendering ---

function redrawAll() {
  ensureInit();
  drawGraph('graph-gyro', graphData.gyro, getScale('gyro'));
  drawGraph('graph-acc', graphData.acc, getScale('acc'));
  drawGraph('graph-mag', graphData.mag, getScale('mag'));

  // Update sidebar live values
  updateLiveValues('gyro', latest.gyro, 0);
  updateLiveValues('acc', latest.acc, 2);
  updateLiveValues('mag', latest.mag, 0);
}

function updateLiveValues(name, vals, decimals) {
  setText('gv-' + name + '-x', formatVal(vals.x, decimals));
  setText('gv-' + name + '-y', formatVal(vals.y, decimals));
  setText('gv-' + name + '-z', formatVal(vals.z, decimals));
}

function formatVal(v, decimals) {
  return v.toFixed(decimals);
}

function drawGraph(canvasId, data, yMax) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  // Size canvas buffer to match display (HiDPI-aware)
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
  }

  ctx.clearRect(0, 0, w, h);

  const plotLeft = Y_MARGIN;
  const plotRight = w - 8;
  const plotTop = 6;
  const plotBottom = h - 6;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Draw grid lines + Y labels (fixed scale)
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const frac = i / ticks;
    const y = plotTop + frac * plotH;
    const val = yMax - frac * 2 * yMax;

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();

    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(formatTick(val), plotLeft - 4, y);
  }

  // Draw scrolling vertical grid lines
  const gridSpacing = Math.round(MAX_SAMPLES / 6);
  const pxPerSample = plotW / (MAX_SAMPLES - 1);
  const offset = sampleCount >= MAX_SAMPLES ? sampleCount % gridSpacing : 0;
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  for (let s = -offset; s < MAX_SAMPLES; s += gridSpacing) {
    if (s < 0) continue;
    const x = plotLeft + s * pxPerSample;
    if (x < plotLeft || x > plotRight) continue;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
  }

  // Draw zero line slightly brighter
  const zeroY = plotTop + plotH / 2;
  ctx.strokeStyle = AXIS_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotLeft, zeroY);
  ctx.lineTo(plotRight, zeroY);
  ctx.stroke();

  // Draw data lines (clipped to plot area)
  if (data.x.length > 0) {
    drawLine(ctx, data.x, yMax, plotLeft, plotTop, plotW, plotH, COLORS.x);
    drawLine(ctx, data.y, yMax, plotLeft, plotTop, plotW, plotH, COLORS.y);
    drawLine(ctx, data.z, yMax, plotLeft, plotTop, plotW, plotH, COLORS.z);
  }
}

function drawLine(ctx, arr, yMax, plotLeft, plotTop, plotW, plotH, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotW, plotH);
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();

  for (let i = 0; i < arr.length; i++) {
    const x = plotLeft + (i / (MAX_SAMPLES - 1)) * plotW;
    const y = plotTop + plotH / 2 - (arr[i] / yMax) * (plotH / 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Format tick label */
function formatTick(val) {
  if (val === 0) return '0';
  if (Math.abs(val) >= 10) return val.toFixed(0);
  if (Math.abs(val) >= 1) return val.toFixed(1);
  return val.toFixed(2);
}
