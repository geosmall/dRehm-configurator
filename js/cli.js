/**
 * @file cli.js
 * @brief CLI mode switching protocol for dRehmFlight PWA Configurator
 *
 * Manages transitions between MSP (binary telemetry) and CLI (text command) modes.
 * Protocol: send '#' to enter CLI, send 'exit\r\n' to exit back to MSP.
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

/**
 * Feed raw bytes from serial while in CLI mode.
 * Decodes to text and dispatches to callback.
 */
export function cliParse(data) {
  if (!inCliMode) return;
  const text = decoder.decode(data, { stream: true });
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
 * Enter CLI mode: switch serial receiver, send '#' trigger.
 * @param {Serial} serial - Serial port instance
 * @param {function} switchReceiver - Switches serial.onReceive to cliParse
 */
export async function enterCli(serial, switchReceiver) {
  if (inCliMode) return;
  inCliMode = true;
  switchReceiver();
  await serial.write(new Uint8Array([0x23]));  // '#'
  await sleep(100);
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
}
