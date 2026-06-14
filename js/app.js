/**
 * @file app.js
 * @brief Entry point — connection UI, tab switching, MSP polling, CLI mode switching
 */

import { Serial } from './serial.js';
import { MspParser, MSP, REBOOT_MODE, mspEncode, readU8, readU16, readU32 } from './msp.js';
import { setText, sensorString, sleep } from './util.js';
import { handleStatusMessage } from './tabs/status.js';
import { handleReceiverMessage } from './tabs/receiver.js';
import { handleSensorsMessage } from './tabs/sensors.js';
import { cliParse, enterCli, exitCli, cliReset, setRebootCallback } from './cli.js';
import { initTerminal, onTerminalActivate, onTerminalDeactivate } from './tabs/terminal.js';
import { initLog, log } from './log.js';

// --- Globals ---
const serial = new Serial();
const parser = new MspParser();
let pollTimer = null;
let activeTab = 'status';
let reconnecting = false;

// --- Reboot/reconnect (mirrors betaflight-configurator's serial reconnect) ---
// A command that may reboot the FC (CLI exit, save, reboot) stamps a window; a port
// drop within it is treated as a reboot (→ retry-reconnect) rather than an unplug.
// dRehmFlight's soft CLI exit produces no drop, so the window just expires harmlessly.
const REBOOT_WINDOW_MS           = 10000; // a drop within this of a reboot cmd = reboot, not unplug
const REBOOT_FLUSH_DELAY_MS      = 1500;  // let the reset + USB drop settle before the first attempt
const REBOOT_RECONNECT_RETRY_MS  = 1000;  // retry cadence
const REBOOT_CONNECT_MAX_TIME_MS = 10000; // overall reconnect window
const RECONNECT_PROBE_MS         = 800;   // per-attempt wait for an MSP response before retrying
let rebootExpectedUntil = 0;              // performance.now() deadline for "drop == reboot"

// --- Link quality ---
let lastMspResponseMs = 0;
let prevLinkState = '';
const LINK_STALE_MS = 2000;
const LINK_DEAD_MS  = 5000;

// --- FC identity (populated on connect) ---
let fcVariant = '';
let fcVersion = '';
let boardName = '';

// --- DOM refs ---
const btnConnect  = document.getElementById('btn-connect');
const connStatus  = document.getElementById('conn-status');
const portSelect  = document.getElementById('port-select');
const sidebar     = document.getElementById('sidebar');
const statusBar   = document.getElementById('status-bar');
const btnDfu      = document.getElementById('btn-dfu');
const btnUf2      = document.getElementById('btn-uf2');

// --- Port scanning ---

/** Scanned port objects keyed by dropdown index */
let scannedPorts = [];

async function refreshPortList() {
  const ports = await serial.scanPorts();
  scannedPorts = ports;

  portSelect.innerHTML = '';
  for (let i = 0; i < ports.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ports[i].label;
    portSelect.appendChild(opt);
  }

  // Always add "New port..." option
  const newOpt = document.createElement('option');
  newOpt.value = 'new';
  newOpt.textContent = ports.length ? '+ New port...' : 'Select port...';
  portSelect.appendChild(newOpt);

  // Auto-select first real port if available
  if (ports.length > 0) {
    portSelect.value = '0';
  }
}

// Initial scan + event-driven updates
serial.onPortsChanged = () => { if (!serial.connected) refreshPortList(); };
serial.startPortEvents();
refreshPortList();

// --- Log ---
initLog();
fetch('manifest.json').then(r => r.json()).then(m => {
  if (m.version) {
    setText('configurator-version', m.version);
    log(`Configurator v${m.version} started — ${navigator.platform}`);
  }
}).catch(() => {
  log(`Configurator started — ${navigator.platform}`);
});
if (!navigator.serial) log('WebSerial API not available — use Chrome or Edge');

// --- Connection ---

btnConnect.addEventListener('click', async () => {
  if (btnConnect.disabled) return;
  btnConnect.disabled = true;
  try { await handleConnectClick(); } finally { btnConnect.disabled = false; }
});

async function handleConnectClick() {
  if (reconnecting) {
    // Cancel the in-progress reconnect loop (it checks `reconnecting` each tick)
    reconnecting = false;
    await serial.disconnect();
    disconnectUI();
    refreshPortList();
    return;
  }
  if (serial.connected) {
    // If in CLI mode, exit first
    if (activeTab === 'terminal') {
      await exitCli(serial, switchToMsp);
    }
    rebootExpectedUntil = 0;
    serial.onDisconnect = null;  // Prevent read loop from double-firing onDisconnect
    stopPolling();
    await serial.disconnect();
    disconnectUI();
    refreshPortList();
  } else {
    try {
      const sel = portSelect.value;
      if (sel !== 'new' && scannedPorts[parseInt(sel)]) {
        await serial.connectPort(scannedPorts[parseInt(sel)].port, 115200);
      } else {
        await serial.connectNew(115200);
      }
      onConnect();
      log('Serial port opened');
      // Refresh to pick up newly-granted port
      refreshPortList();
    } catch (err) {
      console.error('Connect failed:', err);
      connStatus.textContent = 'Connection failed';
      log('Connection failed: ' + err.message);
    }
  }
}

function onConnect() {
  // Clear stale state from any prior connection (BF/INAV pattern)
  parser.reset();
  cliReset();
  lastMspResponseMs = 0;
  updateLinkIndicator('');

  btnConnect.textContent = 'Disconnect';
  connStatus.textContent = 'Connected';
  connStatus.classList.remove('disconnected', 'reconnecting');
  connStatus.classList.add('connected');
  portSelect.disabled = true;
  sidebar.classList.remove('hidden');
  statusBar.classList.remove('hidden');

  // Wire serial data into MSP parser
  serial.onReceive = (data) => parser.parse(data);
  serial.onDisconnect = () => onDisconnect();

  // Wire parsed MSP messages to handler
  parser.onMessage = handleMessage;

  // Initialize terminal tab
  initTerminal(serial);

  // Reboot detection (CLI "Rebooting" text) — arm the reconnect window as a hint.
  // The tab-switch exit path arms it explicitly too, since Betaflight emits "Rebooting"
  // too late for the CLI parser to catch it.
  setRebootCallback(armRebootWindow);

  // Query identity then start polling
  queryIdentity();
}

function onDisconnect() {
  stopPolling();
  cliReset();
  log('Serial port closed');

  // A drop within the reboot window = the FC rebooted (CLI exit/reboot/save) →
  // retry-reconnect. Otherwise it's a genuine unplug → disconnect (Decision A).
  const rebootExpected = performance.now() < rebootExpectedUntil;
  rebootExpectedUntil = 0;
  if (rebootExpected) {
    handleRebootReconnect();
    return;
  }

  disconnectUI();
}

/** Full UI teardown for a real disconnect */
function disconnectUI() {
  btnConnect.textContent = 'Connect';
  connStatus.textContent = 'Disconnected';
  connStatus.classList.remove('connected', 'reconnecting');
  connStatus.classList.add('disconnected');
  portSelect.disabled = false;
  sidebar.classList.add('hidden');
  statusBar.classList.add('hidden');
  updateBootloaderControls(true);  // disable bootloader buttons until armed state is known
  setText('fc-info', '');
  fcVariant = '';
  fcVersion = '';
  boardName = '';

  // Reset all displayed values to '--'
  document.querySelectorAll('.val').forEach(el => el.textContent = '--');

  // If terminal was active, switch back to status tab visually
  if (activeTab === 'terminal') {
    activateTab('status');
  }
}

/** Mark that we just issued a command that may reboot the FC. A port drop within
 *  the window is then treated as a reboot (→ reconnect) rather than an unplug. */
function armRebootWindow() {
  rebootExpectedUntil = performance.now() + REBOOT_WINDOW_MS;
}

/**
 * Reconnect after an FC reboot. Mirrors betaflight-configurator: wait for the reset
 * to settle, then retry-connect on a cadence within a generous window, confirming
 * success with a real MSP response (not just a reopened port). Tolerant of early
 * attempts that connect to a still-booting FC and get dropped.
 */
async function handleRebootReconnect() {
  reconnecting = true;
  log('FC rebooting — reconnecting...');
  connStatus.textContent = 'Reconnecting...';
  connStatus.classList.remove('connected', 'disconnected');
  connStatus.classList.add('reconnecting');
  if (activeTab === 'terminal') activateTab('status');

  // Capture the USB identity, then release the stale handle. After a CDC
  // re-enumeration that handle is dead; we reconnect to the live object that
  // getPorts() exposes for the same VID/PID, not this reference.
  const info = serial.port ? serial.port.getInfo() : null;
  serial.onDisconnect = null;  // we drive connect/disconnect ourselves during the loop
  await serial.disconnect();

  if (!info || info.usbVendorId === undefined) {
    reconnecting = false;
    log('Auto-reconnect failed — no USB identity to match');
    disconnectUI();
    return;
  }

  // Let the reset + USB drop settle before the first attempt.
  await sleep(REBOOT_FLUSH_DELAY_MS);

  const deadline = performance.now() + REBOOT_CONNECT_MAX_TIME_MS;
  let sawPort = false;
  while (reconnecting && performance.now() < deadline) {
    const candidates = await serial.getMatchingPorts(info.usbVendorId, info.usbProductId);
    for (const cand of candidates) {
      if (!reconnecting) break;
      sawPort = true;
      if (await tryReconnect(cand)) {
        if (!reconnecting) {           // user clicked Disconnect mid-attempt
          await serial.disconnect();
          return;
        }
        reconnecting = false;
        log('Auto-reconnect successful');
        onConnect();
        return;
      }
    }
    await sleep(REBOOT_RECONNECT_RETRY_MS);
  }

  if (reconnecting) {
    reconnecting = false;
    const secs = REBOOT_CONNECT_MAX_TIME_MS / 1000;
    log(sawPort
      ? `Auto-reconnect failed — FC did not respond within ${secs}s`
      : `Auto-reconnect failed — port did not reappear within ${secs}s`);
  }
  disconnectUI();
}

/**
 * One reconnect attempt against a candidate port: open it, then probe with an MSP
 * query. Returns true only if the FC answers; otherwise closes and lets the caller
 * retry the next candidate / tick.
 */
async function tryReconnect(port) {
  try {
    await serial.connectPort(port, 115200);
  } catch {
    return false;  // not re-enumerated yet
  }
  serial.onReceive = (data) => parser.parse(data);
  const answered = await probeMsp(RECONNECT_PROBE_MS);
  if (!answered) {
    await serial.disconnect();  // opened but FC still booting — drop and retry
    return false;
  }
  return true;
}

/** Send one identity query and resolve true on any MSP response, false on timeout. */
function probeMsp(timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parser.onMessage = null;
      resolve(val);
    };
    parser.reset();
    parser.onMessage = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    serial.write(mspEncode(MSP.API_VERSION)).catch(() => {});
  });
}

// --- Serial receive switching ---

/** Switch serial.onReceive to MSP parser */
function switchToMsp() {
  serial.onReceive = (data) => parser.parse(data);
}

/** Switch serial.onReceive to CLI text parser */
function switchToCli() {
  serial.onReceive = (data) => cliParse(data);
}

// --- Identity handshake ---

async function queryIdentity() {
  // Send identity queries with small delays for reliable parsing
  await serial.write(mspEncode(MSP.API_VERSION));
  await sleep(50);
  await serial.write(mspEncode(MSP.FC_VARIANT));
  await sleep(50);
  await serial.write(mspEncode(MSP.FC_VERSION));
  await sleep(50);
  await serial.write(mspEncode(MSP.BOARD_INFO));
  await sleep(50);

  // Start polling after identity queries sent
  startPolling();
}

// --- Message dispatch ---

function handleMessage(msg) {
  lastMspResponseMs = performance.now();
  updateLinkIndicator('active');

  // Identity responses
  switch (msg.cmd) {
    case MSP.FC_VARIANT:
      fcVariant = String.fromCharCode(...msg.payload.slice(0, 4));
      updateFcInfo();
      break;

    case MSP.FC_VERSION:
      fcVersion = `${readU8(msg.payload, 0)}.${readU8(msg.payload, 1)}.${readU8(msg.payload, 2)}`;
      updateFcInfo();
      break;

    case MSP.BOARD_INFO: {
      const nameLen = readU8(msg.payload, 8);
      boardName = String.fromCharCode(...msg.payload.slice(9, 9 + nameLen));
      updateFcInfo();
      log(`Connected — ${fcVariant} v${fcVersion} on ${boardName}`);
      break;
    }
  }

  // Status bar (always updated regardless of active tab)
  updateStatusBar(msg);

  // Dispatch to all tab handlers (each filters by its own MSP codes).
  // Individual try/catch so one handler failure doesn't block the others.
  try { handleStatusMessage(msg); } catch (e) { console.error('Status handler:', e); }
  try { handleReceiverMessage(msg); } catch (e) { console.error('Receiver handler:', e); }
  try { handleSensorsMessage(msg); } catch (e) { console.error('Sensors handler:', e); }
}

function updateFcInfo() {
  const parts = [];
  if (fcVariant) parts.push(fcVariant);
  if (fcVersion) parts.push('v' + fcVersion);
  if (boardName) parts.push(boardName);
  setText('fc-info', parts.join(' | '));

  // Show version in status bar
  if (fcVersion) {
    setText('bar-version', 'v' + fcVersion);
  }
}

/** Update the always-visible status bar from MSP_STATUS */
function updateStatusBar(msg) {
  if (msg.cmd !== MSP.STATUS) return;

  const cycleTime = readU16(msg.payload, 0);
  const cpuLoad   = readU16(msg.payload, 2);
  const sensors   = readU16(msg.payload, 4);
  const flags     = readU32(msg.payload, 6);
  const armed     = (flags & 1) !== 0;

  setText('bar-armed', armed ? 'YES' : 'NO');
  setText('bar-cycle', cycleTime + ' \u00B5s');
  setText('bar-cpu', cpuLoad + '%');
  setText('bar-sensors', sensorString(sensors));

  updateBootloaderControls(armed);
}

// --- Bootloader entry ---

/** Enable/disable bootloader buttons based on armed state (FC refuses while armed) */
function updateBootloaderControls(armed) {
  if (btnDfu) btnDfu.disabled = armed;
  if (btnUf2) btnUf2.disabled = armed;
  const warn = document.getElementById('bootloader-armed-warn');
  if (warn) warn.classList.toggle('hidden', !armed);
}

/**
 * Send MSP_REBOOT with a bootloader mode, then tear the connection down cleanly.
 * The board re-enumerates as a bootloader device (not MSP/CLI), so this does NOT
 * use the auto-reconnect path \u2014 we disconnect and show reflash guidance instead.
 */
async function sendBootloaderReboot(mode) {
  if (!serial.connected) return;
  rebootExpectedUntil = 0;        // bootloader device won't return as MSP/CLI \u2014 no reconnect
  serial.onDisconnect = null;     // we own the teardown; prevent read-loop double-fire

  try {
    await serial.write(mspEncode(MSP.REBOOT, [mode]));
  } catch (err) {
    log('Failed to send MSP_REBOOT: ' + err.message);
    serial.onDisconnect = () => onDisconnect();
    return;
  }
  log(`MSP_REBOOT sent (mode ${mode}) \u2014 board entering bootloader`);

  // Let the FC ACK + flush + reset and the USB device re-enumerate before closing.
  await sleep(500);
  stopPolling();
  await serial.disconnect();
  disconnectUI();
  showBootloaderGuidance(mode);
  refreshPortList();
}

/** Populate and show the post-reboot reflash guidance overlay */
function showBootloaderGuidance(mode) {
  const titleEl = document.getElementById('bl-guide-title');
  const bodyEl  = document.getElementById('bl-guide-body');
  const overlay = document.getElementById('bootloader-guidance');
  if (!titleEl || !bodyEl || !overlay) return;

  if (mode === REBOOT_MODE.BOOTLOADER_ROM) {
    titleEl.textContent = 'DFU bootloader (revert to stock)';
    bodyEl.innerHTML =
      '<p>The board is now in the ST DFU bootloader (USB <code>0483:df11</code>). ' +
      'It is no longer an MSP/CLI device.</p>' +
      '<p>Reflash stock firmware with <code>dfu-util</code>:</p>' +
      '<pre>dfu-util -a 0 -s 0x08000000:mass-erase:force\n' +
      'dfu-util -R -a 0 --dfuse-address 0x08000000 -D &lt;stock&gt;.bin</pre>' +
      '<p>Power-cycle the board to return to normal firmware boot.</p>';
  } else if (mode === REBOOT_MODE.BOOTLOADER_FLASH) {
    titleEl.textContent = 'UF2 bootloader (.uf2 update)';
    bodyEl.innerHTML =
      '<p>The board is now in the UF2 bootloader (USB <code>239a:006f</code>). ' +
      'A mass-storage drive should appear on your computer.</p>' +
      '<p>Drag the new dRehmFlight <code>.uf2</code> file onto that drive. ' +
      'The board reboots into the new firmware when the copy completes.</p>';
  } else {
    titleEl.textContent = 'Bootloader';
    bodyEl.innerHTML = '<p>The board has rebooted.</p>';
  }
  overlay.classList.remove('hidden');
}

/** Update link quality dot + label in status bar */
function updateLinkIndicator(state) {
  const el = document.getElementById('link-indicator');
  if (!el) return;
  el.className = 'link-indicator ' + state;
  const label = el.querySelector('.link-label');
  if (label) {
    label.textContent = state === 'active' ? 'OK' : state === 'stale' ? 'Stale' : state === 'dead' ? 'Lost' : '--';
  }
  // Log transitions only
  if (state !== prevLinkState) {
    if (state === 'stale') log('Link stale — no MSP response for 2s');
    else if (state === 'dead') log('Link lost — no MSP response for 5s');
    else if (state === 'active' && (prevLinkState === 'stale' || prevLinkState === 'dead')) log('Link recovered');
    prevLinkState = state;
  }
}

// --- Polling ---

/** Get poll interval: sensors tab uses selectable refresh rate, others 250ms */
function getPollInterval() {
  if (activeTab === 'sensors') {
    const sel = document.getElementById('sensor-refresh');
    return sel ? parseInt(sel.value) : 100;
  }
  return 250;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => pollActiveTab(), getPollInterval());
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  parser.reset();
}

/** Restart polling with updated interval (called on refresh rate change or tab switch) */
function restartPolling() {
  if (!serial.connected || activeTab === 'terminal') return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => pollActiveTab(), getPollInterval());
}

async function pollActiveTab() {
  if (!serial.connected) return;

  // Link quality check
  if (lastMspResponseMs > 0) {
    const elapsed = performance.now() - lastMspResponseMs;
    if (elapsed > LINK_DEAD_MS) updateLinkIndicator('dead');
    else if (elapsed > LINK_STALE_MS) updateLinkIndicator('stale');
  }

  // Always poll MSP_STATUS for the status bar
  const commands = [MSP.STATUS];

  switch (activeTab) {
    case 'status':
      commands.push(MSP.ATTITUDE, MSP.ANALOG);
      break;
    case 'receiver':
      commands.push(MSP.RC);
      break;
    case 'sensors':
      commands.push(MSP.RAW_IMU);
      break;
    // terminal tab doesn't poll MSP — it's in CLI mode
  }

  for (const cmd of commands) {
    const frame = mspEncode(cmd);
    parser.trackRequest(cmd, () => serial.write(frame).catch(() => {}));
    try {
      await serial.write(frame);
    } catch {
      return;  // Port closed — disconnect handler will clean up
    }
  }
}

// --- Tab switching ---

/** Activate a tab by name (updates DOM + activeTab state) */
function activateTab(target) {
  // Update tab buttons
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === target);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  const section = document.getElementById('tab-' + target);
  if (section) {
    section.classList.add('active');
    // Reset displayed values so fresh data arrival is visible
    section.querySelectorAll('.val').forEach(el => el.textContent = '--');
  }

  activeTab = target;
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    const target = tab.dataset.tab;
    if (target === activeTab) return;

    const prevTab = activeTab;
    const wasTerminal = activeTab === 'terminal';
    const goingToTerminal = target === 'terminal';

    // Leaving terminal → exit CLI, resume polling. On dRehmFlight `exit` soft-returns
    // (no drop); on Betaflight it reboots. Arm the reconnect window so that if the port
    // drops shortly after, onDisconnect treats it as a reboot rather than an unplug.
    if (wasTerminal && serial.connected) {
      log('Exiting CLI mode');
      onTerminalDeactivate();
      armRebootWindow();
      await exitCli(serial, switchToMsp);
      parser.reset();
      lastMspResponseMs = 0;  // Suppress stale check until first response
      statusBar.classList.remove('stale');
      startPolling();
    }

    activateTab(target);

    // Entering terminal → stop MSP, enter CLI
    if (goingToTerminal && serial.connected) {
      stopPolling();
      statusBar.classList.add('stale');
      updateLinkIndicator('');
      onTerminalActivate();  // Set auto-load flag before CLI entry so banner prompt triggers it
      const ok = await enterCli(serial, switchToCli, switchToMsp);
      if (!ok) {
        log('CLI entry failed — FC did not respond');
        activateTab(prevTab);
        startPolling();
        return;
      }
      log('Entered CLI mode');
    }

    // Switching between non-terminal tabs → restart polling at correct rate
    if (!wasTerminal && !goingToTerminal && serial.connected) {
      restartPolling();
    }
  });
});

// Refresh rate change → restart polling immediately
const refreshSel = document.getElementById('sensor-refresh');
if (refreshSel) {
  refreshSel.addEventListener('change', () => restartPolling());
}

// --- Bootloader controls ---

if (btnDfu) {
  btnDfu.addEventListener('click', () => {
    if (btnDfu.disabled) return;
    if (confirm('Reboot the flight controller into the ST DFU bootloader?\n\n' +
                'The board will disconnect from the configurator. Reflash firmware ' +
                'with dfu-util, or power-cycle the board to return to the current firmware.')) {
      sendBootloaderReboot(REBOOT_MODE.BOOTLOADER_ROM);
    }
  });
}

if (btnUf2) {
  btnUf2.addEventListener('click', () => {
    if (btnUf2.disabled) return;
    if (confirm('Reboot the flight controller into the UF2 bootloader?\n\n' +
                'The board will disconnect and appear as a mass-storage drive ' +
                'for drag-and-drop firmware update.')) {
      sendBootloaderReboot(REBOOT_MODE.BOOTLOADER_FLASH);
    }
  });
}

const blGuideClose = document.getElementById('bl-guide-close');
if (blGuideClose) {
  blGuideClose.addEventListener('click', () => {
    document.getElementById('bootloader-guidance').classList.add('hidden');
  });
}
