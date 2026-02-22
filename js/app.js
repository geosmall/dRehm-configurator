/**
 * @file app.js
 * @brief Entry point — connection UI, tab switching, MSP polling, CLI mode switching
 */

import { Serial } from './serial.js';
import { MspParser, MSP, mspEncode, readU8, readU16, readU32 } from './msp.js';
import { setText, sensorString, sleep } from './util.js';
import { handleStatusMessage } from './tabs/status.js';
import { handleReceiverMessage } from './tabs/receiver.js';
import { handleSensorsMessage } from './tabs/sensors.js';
import { cliParse, enterCli, exitCli, cliReset } from './cli.js';
import { initTerminal, onTerminalActivate, onTerminalDeactivate } from './tabs/terminal.js';

// --- Globals ---
const serial = new Serial();
const parser = new MspParser();
let pollTimer = null;
let activeTab = 'status';

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

// --- Connection ---

btnConnect.addEventListener('click', async () => {
  if (serial.connected) {
    // If in CLI mode, exit first
    if (activeTab === 'terminal') {
      await exitCli(serial, switchToMsp);
    }
    stopPolling();
    await serial.disconnect();
    onDisconnect();
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
      // Refresh to pick up newly-granted port
      refreshPortList();
    } catch (err) {
      console.error('Connect failed:', err);
    }
  }
});

function onConnect() {
  btnConnect.textContent = 'Disconnect';
  connStatus.textContent = 'Connected';
  connStatus.classList.remove('disconnected');
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

  // Query identity then start polling
  queryIdentity();
}

function onDisconnect() {
  stopPolling();
  cliReset();
  btnConnect.textContent = 'Connect';
  connStatus.textContent = 'Disconnected';
  connStatus.classList.remove('connected');
  connStatus.classList.add('disconnected');
  portSelect.disabled = false;
  sidebar.classList.add('hidden');
  statusBar.classList.add('hidden');
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
      break;
    }
  }

  // Status bar (always updated regardless of active tab)
  updateStatusBar(msg);

  // Dispatch to all tab handlers (each filters by its own MSP codes)
  handleStatusMessage(msg);
  handleReceiverMessage(msg);
  handleSensorsMessage(msg);
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
    await serial.write(mspEncode(cmd));
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
  if (section) section.classList.add('active');

  activeTab = target;
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    const target = tab.dataset.tab;
    if (target === activeTab) return;

    const wasTerminal = activeTab === 'terminal';
    const goingToTerminal = target === 'terminal';

    // Leaving terminal → exit CLI, resume MSP
    if (wasTerminal && serial.connected) {
      onTerminalDeactivate();
      await exitCli(serial, switchToMsp);
      parser.reset();
      startPolling();
    }

    activateTab(target);

    // Entering terminal → stop MSP, enter CLI
    if (goingToTerminal && serial.connected) {
      stopPolling();
      onTerminalActivate();  // Set auto-load flag before CLI entry so banner prompt triggers it
      await enterCli(serial, switchToCli);
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
