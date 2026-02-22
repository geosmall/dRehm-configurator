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

    /** Called with { cmd, payload: Uint8Array } on valid frame */
    this.onMessage = null;
  }

  /** Feed raw bytes from serial into the parser */
  parse(data) {
    for (let i = 0; i < data.length; i++) {
      this._processByte(data[i]);
    }
  }

  /** Reset parser state */
  reset() {
    this.state = S_IDLE;
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
        if ((this.checksum & 0xFF) === c && this.onMessage) {
          this.onMessage({ cmd: this.cmd, payload: this.payload });
        }
        break;
    }
  }
}

/**
 * Build an MSP V1 request frame.
 * @param {number} cmd - MSP command code
 * @returns {Uint8Array} Complete frame ready to send
 */
export function mspEncode(cmd) {
  // $M< + len(0) + cmd + checksum
  const checksum = (0 ^ cmd) & 0xFF;
  return new Uint8Array([0x24, 0x4D, 0x3C, 0x00, cmd, checksum]);
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
