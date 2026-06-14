/**
 * @file msp.js
 * @brief MSP V1 encoder/decoder for dRehmFlight PWA Configurator
 *
 * Encodes MSP V1 request frames and parses V1 response frames.
 * Dispatches decoded messages via onMessage callback.
 */

// MSP V1 command codes (must match msp.h)
export const MSP = {
  API_VERSION: 1,
  FC_VARIANT:  2,
  FC_VERSION:  3,
  BOARD_INFO:  4,
  STATUS:      101,
  RAW_IMU:     102,
  RC:          105,
  ATTITUDE:    108,
  ANALOG:      110,
  REBOOT:      68,
};

// MSP_REBOOT payload modes (must match msp.h on the FC).
// Only FIRMWARE / BOOTLOADER_ROM (+ BOOTLOADER_FLASH when bootuf2 is present)
// are actioned by the FC; others are ACK-only.
export const REBOOT_MODE = {
  FIRMWARE:        0,  // plain NVIC_SystemReset (normal reboot)
  BOOTLOADER_ROM:  1,  // ST system DFU bootloader (USB 0483:df11)
  BOOTLOADER_FLASH: 4, // bootuf2 (USB 239a:006f, mass-storage)
};

// Parser states
const S_IDLE     = 0;
const S_HEADER_M = 1;
const S_DIR      = 2;
const S_LEN      = 3;
const S_CMD      = 4;
const S_PAYLOAD  = 5;
const S_CHECKSUM = 6;

export class MspParser {
  constructor() {
    this.state = S_IDLE;
    this.len = 0;
    this.cmd = 0;
    this.checksum = 0;
    this.payload = [];
    this.payloadIdx = 0;
    this.pending = [];

    /** Called with { cmd, payload: Uint8Array } on valid frame */
    this.onMessage = null;
    /** Called with cmd code when request fails after retry */
    this.onTimeout = null;
  }

  /** Feed raw bytes from serial into the parser */
  parse(data) {
    for (let i = 0; i < data.length; i++) {
      this._processByte(data[i]);
    }
  }

  /** Reset parser state and cancel pending requests */
  reset() {
    this.state = S_IDLE;
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending = [];
  }

  /** Track an outgoing request for timeout/retry */
  trackRequest(cmd, sendFn) {
    const entry = {
      cmd, retried: false, sendFn,
      timer: setTimeout(() => this._onTimeout(entry), 1000),
    };
    this.pending.push(entry);
  }

  /** Remove oldest pending entry for cmd (called on valid response) */
  _resolveRequest(cmd) {
    const idx = this.pending.findIndex(p => p.cmd === cmd);
    if (idx >= 0) {
      clearTimeout(this.pending[idx].timer);
      this.pending.splice(idx, 1);
    }
  }

  /** Handle request timeout — retry once, then notify */
  _onTimeout(entry) {
    const idx = this.pending.indexOf(entry);
    if (idx < 0) return;
    if (!entry.retried) {
      entry.retried = true;
      entry.timer = setTimeout(() => this._onTimeout(entry), 1000);
      entry.sendFn();
    } else {
      this.pending.splice(idx, 1);
      if (this.onTimeout) this.onTimeout(entry.cmd);
    }
  }

  _processByte(c) {
    switch (this.state) {
      case S_IDLE:
        if (c === 0x24) this.state = S_HEADER_M;  // '$'
        break;

      case S_HEADER_M:
        this.state = (c === 0x4D) ? S_DIR : S_IDLE;  // 'M'
        break;

      case S_DIR:
        if (c === 0x3E) {  // '>' response
          this.state = S_LEN;
        } else {
          this.state = S_IDLE;
        }
        break;

      case S_LEN:
        this.len = c;
        this.checksum = c;
        this.payload = new Uint8Array(c);
        this.payloadIdx = 0;
        this.state = S_CMD;
        break;

      case S_CMD:
        this.cmd = c;
        this.checksum ^= c;
        this.state = (this.len > 0) ? S_PAYLOAD : S_CHECKSUM;
        break;

      case S_PAYLOAD:
        this.payload[this.payloadIdx++] = c;
        this.checksum ^= c;
        if (this.payloadIdx >= this.len) this.state = S_CHECKSUM;
        break;

      case S_CHECKSUM:
        this.state = S_IDLE;
        if ((this.checksum & 0xFF) === c) {
          this._resolveRequest(this.cmd);
          if (this.onMessage) {
            try {
              this.onMessage({ cmd: this.cmd, payload: this.payload });
            } catch (e) {
              console.error('MSP handler error:', e);
            }
          }
        }
        break;
    }
  }
}

/**
 * Build an MSP V1 request frame.
 * @param {number} cmd - MSP command code
 * @param {number[]|Uint8Array} [payload=[]] - Optional payload bytes
 * @returns {Uint8Array} Complete frame ready to send
 *
 * Frame: '$' 'M' '<' len cmd <payload...> checksum
 * checksum = XOR of len, cmd, and every payload byte.
 */
export function mspEncode(cmd, payload = []) {
  const len = payload.length;
  let checksum = len ^ cmd;
  const frame = [0x24, 0x4D, 0x3C, len, cmd];
  for (const b of payload) {
    frame.push(b & 0xFF);
    checksum ^= b;
  }
  frame.push(checksum & 0xFF);
  return new Uint8Array(frame);
}

// Payload data view helpers
export function readU8(payload, offset) {
  return payload[offset];
}

export function readU16(payload, offset) {
  return payload[offset] | (payload[offset + 1] << 8);
}

export function readS16(payload, offset) {
  const val = readU16(payload, offset);
  return val > 32767 ? val - 65536 : val;
}

export function readU32(payload, offset) {
  return payload[offset] | (payload[offset + 1] << 8) |
         (payload[offset + 2] << 16) | (payload[offset + 3] << 24);
}
