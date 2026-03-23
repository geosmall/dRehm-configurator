/**
 * @file cli.js
 * @brief CLI mode switching protocol for dRehmFlight PWA Configurator
 *
 * Manages transitions between MSP (binary telemetry) and CLI (text command) modes.
 * Protocol: send '#' to enter CLI, send 'exit\r\n' to reboot FC (BF/INAV pattern).
 */

import { sleep } from './util.js';

/** CLI mode state */
let inCliMode = false;

/** Callback for received text data in CLI mode */
let onTextReceive = null;

/** Text decoder for incoming bytes */
const decoder = new TextDecoder();

/** Text encoder for outgoing commands */
const encoder = new TextEncoder();

/** Banner validation state */
let bannerResolve = null;
let bannerTimer = null;

function waitForBanner(timeoutMs) {
  return new Promise(resolve => {
    bannerResolve = resolve;
    bannerTimer = setTimeout(() => {
      bannerResolve = null;
      bannerTimer = null;
      resolve(false);
    }, timeoutMs);
  });
}

/**
 * Feed raw bytes from serial while in CLI mode.
 * Decodes to text, validates CLI banner if pending, dispatches to callback.
 */
export function cliParse(data) {
  if (!inCliMode) return;
  const text = decoder.decode(data, { stream: true });
  if (bannerResolve && text.includes('CLI')) {
    const r = bannerResolve;
    clearTimeout(bannerTimer);
    bannerResolve = null;
    bannerTimer = null;
    r(true);
  }
  if (onTextReceive) onTextReceive(text);
}

/**
 * Set callback for received CLI text.
 * @param {function(string)} cb - Called with decoded text chunks
 */
export function setCliReceiver(cb) {
  onTextReceive = cb;
}

/**
 * Enter CLI mode: drain in-flight MSP, send '#', validate banner.
 * @param {Serial} serial - Serial port instance
 * @param {function} switchToCli - Switches serial.onReceive to cliParse
 * @param {function} switchToMsp - Restores serial.onReceive to MSP parser (on failure)
 * @returns {Promise<boolean>} true if CLI banner received, false on timeout
 */
export async function enterCli(serial, switchToCli, switchToMsp) {
  if (inCliMode) return true;

  // Drain: wait for in-flight MSP responses to arrive
  await sleep(150);

  inCliMode = true;
  switchToCli();
  await serial.write(new Uint8Array([0x23]));  // '#'

  // Wait for CLI banner (up to 500 ms — includes 100 ms FW guard timer)
  const validated = await waitForBanner(500);
  if (!validated) {
    inCliMode = false;
    switchToMsp();
  }
  return validated;
}

/**
 * Exit CLI mode: send 'exit' command, restore MSP parsing.
 * @param {Serial} serial - Serial port instance
 * @param {function} switchReceiver - Switches serial.onReceive back to MSP parser
 */
export async function exitCli(serial, switchReceiver) {
  if (!inCliMode) return;
  await sendCommand(serial, 'exit');
  await sleep(200);
  inCliMode = false;
  switchReceiver();
}

/**
 * Send a CLI text command (appends \r\n).
 * @param {Serial} serial - Serial port instance
 * @param {string} cmd - Command text
 */
export async function sendCommand(serial, cmd) {
  await serial.write(encoder.encode(cmd + '\r\n'));
}

/** Reset CLI state (e.g. on disconnect) */
export function cliReset() {
  inCliMode = false;
  if (bannerResolve) {
    clearTimeout(bannerTimer);
    bannerResolve(false);
    bannerResolve = null;
    bannerTimer = null;
  }
}
