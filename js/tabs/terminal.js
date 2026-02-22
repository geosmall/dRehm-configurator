/**
 * @file tabs/terminal.js
 * @brief Terminal tab — CLI terminal + structured settings form
 *
 * Terminal: scrollable output, text input, command history (up/down arrow).
 * Settings form: auto-loads params via `set` command, grouped number inputs,
 * dirty tracking, save-only-changed.
 */

import { sendCommand, setCliReceiver } from '../cli.js';
import { sleep } from '../util.js';

/** Parameter groups (matches firmware paramTable order) */
const PARAM_GROUPS = [
  { name: 'PID \u2014 Angle Mode', params: [
    'Kp_roll_angle', 'Ki_roll_angle', 'Kd_roll_angle',
    'Kp_pitch_angle', 'Ki_pitch_angle', 'Kd_pitch_angle'] },
  { name: 'PID \u2014 Yaw', params: [
    'Kp_yaw', 'Ki_yaw', 'Kd_yaw'] },
  { name: 'PID \u2014 Rate Mode', params: [
    'Kp_roll_rate', 'Ki_roll_rate', 'Kd_roll_rate',
    'Kp_pitch_rate', 'Ki_pitch_rate', 'Kd_pitch_rate'] },
  { name: 'Loop Damping', params: [
    'B_loop_roll', 'B_loop_pitch'] },
  { name: 'Controller Limits', params: [
    'i_limit', 'maxRoll', 'maxPitch', 'maxYaw'] },
  { name: 'Filter Coefficients', params: [
    'B_madgwick', 'B_accel', 'B_gyro', 'B_mag'] },
];

/** Command history */
const history = [];
let historyIdx = -1;

/** DOM refs (cached on init) */
let termOutput = null;
let termInput = null;
let settingsForm = null;
let btnSave = null;
let serial = null;
let initialized = false;

/** Capture state for settings load */
let captureBuffer = '';
let capturing = false;
let captureTimer = null;

/** Original values from last load (for dirty tracking) */
const originalValues = new Map();

/** Auto-load flag — triggers settings load on first CLI prompt */
let autoLoadPending = false;

/** When true, next renderForm keeps existing originalValues for dirty tracking */
let preserveOriginalsOnLoad = false;

/** When true, suppress terminal output during load */
let silentLoad = false;

/**
 * Initialize terminal tab. Called from app.js on connect.
 * Event listeners are added only once; serial ref is updated each connect.
 * @param {Serial} serialRef - Serial port instance
 */
export function initTerminal(serialRef) {
  serial = serialRef;

  // Wire CLI text receiver (safe to call multiple times)
  setCliReceiver(onCliText);

  // Only bind DOM + listeners once
  if (initialized) return;
  initialized = true;

  termOutput = document.getElementById('term-output');
  termInput = document.getElementById('term-input');
  settingsForm = document.getElementById('settings-form');
  btnSave = document.getElementById('btn-save-settings');

  termInput.addEventListener('keydown', onInputKey);
  document.getElementById('btn-load-settings').addEventListener('click', loadSettings);
  btnSave.addEventListener('click', saveSettings);
  document.getElementById('btn-defaults-settings').addEventListener('click', loadDefaults);
  document.getElementById('btn-clear-term').addEventListener('click', () => {
    if (termOutput) termOutput.textContent = '';
  });
}

/** Called when terminal tab is activated — focus input, trigger auto-load */
export function onTerminalActivate() {
  if (termInput) termInput.focus();
  autoLoadPending = true;
}

/** Called when terminal tab is deactivated — clear state */
export function onTerminalDeactivate() {
  capturing = false;
  captureBuffer = '';
  autoLoadPending = false;
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
}

/** Handle incoming CLI text */
function onCliText(text) {
  if (capturing) {
    captureBuffer += text;
    // Check if prompt arrived (command completed)
    if (captureBuffer.includes('# ')) {
      finishCapture();
    }
    return;
  }

  appendOutput(text);

  // Auto-load settings once CLI prompt is seen (deferred so current chunk renders first)
  if (autoLoadPending && text.includes('# ')) {
    autoLoadPending = false;
    setTimeout(() => loadSettings(false, true), 0);
  }
}

/** Append text to terminal output and auto-scroll */
function appendOutput(text) {
  if (!termOutput) return;
  termOutput.textContent += text;
  termOutput.scrollTop = termOutput.scrollHeight;
}

/** Handle keydown in terminal input */
function onInputKey(e) {
  if (e.key === 'Enter') {
    const cmd = termInput.value.trim();
    termInput.value = '';
    if (!cmd) return;

    // Block 'exit' — tab switching handles mode return
    if (cmd === 'exit') {
      appendOutput('Click a tab on the left to exit the terminal.\r\n');
      return;
    }

    history.push(cmd);
    historyIdx = history.length;
    sendCommand(serial, cmd);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (historyIdx > 0) {
      historyIdx--;
      termInput.value = history[historyIdx];
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIdx < history.length - 1) {
      historyIdx++;
      termInput.value = history[historyIdx];
    } else {
      historyIdx = history.length;
      termInput.value = '';
    }
  }
}

// --- Settings Form ---

/** Load settings: send `set` (no args) and capture param list.
 *  @param {boolean} preserveOriginals — if true, keep existing originalValues for dirty tracking
 *  @param {boolean} silent — if true, suppress terminal output */
async function loadSettings(preserveOriginals = false, silent = false) {
  if (capturing) return;
  preserveOriginalsOnLoad = preserveOriginals;
  silentLoad = silent;
  captureBuffer = '';
  capturing = true;
  if (!silent) appendOutput('> set\r\n');
  await sendCommand(serial, 'set');

  // Timeout fallback
  captureTimer = setTimeout(() => {
    if (capturing) finishCapture();
  }, 3000);
}

/** Called when capture completes (prompt detected or timeout) */
function finishCapture() {
  capturing = false;
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }

  let content = captureBuffer;

  // Strip everything after last prompt
  const promptIdx = content.lastIndexOf('# ');
  if (promptIdx >= 0) {
    content = content.substring(0, promptIdx);
  }

  // Strip command echo if present
  const echoEnd = content.indexOf('\n');
  if (echoEnd >= 0 && content.substring(0, echoEnd).includes('set')) {
    content = content.substring(echoEnd + 1);
  }

  // Parse "name = value" lines into a Map
  const params = new Map();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const name = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (name && value) {
      params.set(name, value);
    }
  }

  if (params.size > 0) {
    renderForm(params);
    if (!silentLoad) appendOutput(`[Loaded ${params.size} parameters]\r\n`);
  } else {
    appendOutput('[No parameters received \u2014 click Load to retry]\r\n');
  }
}

/** Build grouped form from parsed params */
function renderForm(params) {
  if (!settingsForm) return;

  // Store originals for dirty tracking (skip if preserving previous originals)
  if (!preserveOriginalsOnLoad) {
    originalValues.clear();
    for (const [name, value] of params) {
      originalValues.set(name, value);
    }
  }
  preserveOriginalsOnLoad = false;

  settingsForm.innerHTML = '';
  const placed = new Set();

  // Render defined groups
  for (const group of PARAM_GROUPS) {
    const groupParams = group.params.filter(p => params.has(p));
    if (groupParams.length === 0) continue;

    const groupEl = document.createElement('div');
    groupEl.className = 'settings-group';

    const titleEl = document.createElement('div');
    titleEl.className = 'settings-group-title';
    titleEl.textContent = group.name;
    groupEl.appendChild(titleEl);

    for (const name of groupParams) {
      groupEl.appendChild(createParamRow(name, params.get(name)));
      placed.add(name);
    }

    settingsForm.appendChild(groupEl);
  }

  // Render any unknown params in an "Other" group
  const other = [];
  for (const [name, value] of params) {
    if (!placed.has(name)) other.push([name, value]);
  }
  if (other.length > 0) {
    const groupEl = document.createElement('div');
    groupEl.className = 'settings-group';

    const titleEl = document.createElement('div');
    titleEl.className = 'settings-group-title';
    titleEl.textContent = 'Other';
    groupEl.appendChild(titleEl);

    for (const [name, value] of other) {
      groupEl.appendChild(createParamRow(name, value));
    }

    settingsForm.appendChild(groupEl);
  }

  updateSaveButton();
}

/** Create a single param row: label + number input */
function createParamRow(name, value) {
  const row = document.createElement('div');
  row.className = 'param-row';

  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = name;

  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.className = 'param-input';
  input.dataset.param = name;
  input.value = value;
  input.addEventListener('input', () => onParamInput(row, input));

  row.appendChild(label);
  row.appendChild(input);
  return row;
}

/** Handle param input change — update dirty state */
function onParamInput(row, input) {
  const name = input.dataset.param;
  const original = originalValues.get(name);
  const dirty = input.value !== original;
  row.classList.toggle('dirty', dirty);
  updateSaveButton();
}

/** Update Save button label with dirty count */
function updateSaveButton() {
  if (!btnSave) return;
  const count = getDirtyCount();
  btnSave.textContent = count > 0 ? `Save (${count})` : 'Save';
}

/** Count params that differ from original values */
function getDirtyCount() {
  if (!settingsForm) return 0;
  let count = 0;
  for (const input of settingsForm.querySelectorAll('.param-input')) {
    const original = originalValues.get(input.dataset.param);
    if (input.value !== original) count++;
  }
  return count;
}

/** Save settings: send `set name value` for changed params, then `save` */
async function saveSettings() {
  if (!settingsForm) return;

  const changed = [];
  for (const input of settingsForm.querySelectorAll('.param-input')) {
    const name = input.dataset.param;
    const original = originalValues.get(name);
    if (input.value !== original) {
      changed.push({ name, value: input.value });
    }
  }

  if (changed.length === 0) {
    appendOutput('[No changes to save]\r\n');
    return;
  }

  for (const { name, value } of changed) {
    await sendCommand(serial, `set ${name} ${value}`);
    await sleep(50);
  }

  appendOutput(`> save (${changed.length} parameters)\r\n`);
  await sendCommand(serial, 'save');

  // Update originals to match saved values and clear dirty state
  for (const input of settingsForm.querySelectorAll('.param-input')) {
    originalValues.set(input.dataset.param, input.value);
    input.closest('.param-row').classList.remove('dirty');
  }
  updateSaveButton();
}

/** Load defaults: reset params on FC (RAM only), then reload form */
async function loadDefaults() {
  if (capturing) return;
  appendOutput('> defaults\r\n');
  await sendCommand(serial, 'defaults');
  await sleep(200);
  await loadSettings(true, true);
}
