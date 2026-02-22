/**
 * @file serial.js
 * @brief Web Serial API wrapper for dRehmFlight PWA Configurator
 *
 * Handles port scanning, connect/disconnect, and raw byte I/O.
 * Supports pre-granted port enumeration and real-time connect/disconnect events.
 */

/** Known USB vendor IDs (matches Betaflight/INAV device lists) */
const VENDOR_NAMES = {
  0x0403: 'FTDI',
  0x0483: 'STM32',
  0x10C4: 'CP210x',
  0x1366: 'SEGGER',
  0x1A86: 'CH340',
  0x2341: 'Arduino',
  0x28E9: 'GD32',
  0x2E3C: 'AT32',
  0x314B: 'APM32',
  0x2E8A: 'RP2040',
};

/** Known USB product IDs for more specific labels */
const PRODUCT_NAMES = {
  0x0483_5740: 'STM32 VCP',       // STM32 CDC Virtual COM Port
  0x0483_374E: 'STM32 ST-Link',   // ST-Link NUCLEO boards
  0x0483_3256: 'STM32 HID',       // STM32 in HID mode
  0x1366_0105: 'J-Link',          // SEGGER J-Link
  0x1366_1015: 'J-Link',          // SEGGER J-Link OB
  0x0403_6001: 'FTDI',            // FT232R
  0x10C4_EA60: 'CP210x',          // CP2102/CP2104
};

export class Serial {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.onReceive = null;      // callback(Uint8Array)
    this.onDisconnect = null;
    this.onPortsChanged = null; // callback() — port list changed
  }

  get connected() {
    return this.port !== null && this.reader !== null;
  }

  /** Start listening for port connect/disconnect events */
  startPortEvents() {
    if (!navigator.serial) return;
    navigator.serial.addEventListener('connect', () => {
      if (this.onPortsChanged) this.onPortsChanged();
    });
    navigator.serial.addEventListener('disconnect', (e) => {
      // If the disconnected port is our active port, the read loop will handle it
      if (this.onPortsChanged) this.onPortsChanged();
    });
  }

  /**
   * Scan for previously-granted serial ports.
   * @returns {Array<{port, label}>} Port objects with display labels
   */
  async scanPorts() {
    if (!navigator.serial) return [];
    const ports = await navigator.serial.getPorts();
    const results = ports.map((port, i) => ({
      port,
      label: this._portLabel(port, i),
    }));

    // Add numbering when multiple ports share the same label
    const counts = {};
    for (const r of results) counts[r.label] = (counts[r.label] || 0) + 1;
    const seen = {};
    for (const r of results) {
      if (counts[r.label] > 1) {
        seen[r.label] = (seen[r.label] || 0) + 1;
        r.label = `${r.label} #${seen[r.label]}`;
      }
    }

    return results;
  }

  /** Connect to a specific port object */
  async connectPort(port, baudRate = 115200) {
    await this.disconnect();
    this.port = port;
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this._startReadLoop(this.port.readable);
  }

  /** Prompt user to select a new serial port and open it */
  async connectNew(baudRate = 115200) {
    await this.disconnect();
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this._startReadLoop(this.port.readable);
  }

  /** Close the port and clean up */
  async disconnect() {
    if (this.reader) {
      try { await this.reader.cancel(); } catch {}
      this.reader = null;
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch {}
      this.writer = null;
    }
    if (this.port) {
      try { await this.port.close(); } catch {}
      this.port = null;
    }
  }

  /** Send raw bytes */
  async write(data) {
    if (!this.writer) return;
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.writer.write(buf);
  }

  /** Build a display label from port VID/PID info */
  _portLabel(port, index) {
    const info = port.getInfo();
    if (info.usbVendorId) {
      // Try specific VID:PID match first, then vendor-only
      const key = (info.usbVendorId << 16) | (info.usbProductId & 0xFFFF);
      const name = PRODUCT_NAMES[key] ||
        VENDOR_NAMES[info.usbVendorId] ||
        `VID:${info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')}`;
      return name;
    }
    return `Serial port ${index + 1}`;
  }

  /** Internal: read loop dispatching chunks to onReceive */
  async _startReadLoop(readable) {
    this.reader = readable.getReader();
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && this.onReceive) {
          this.onReceive(value);
        }
      }
    } catch (err) {
      // Port disconnected or read error
    } finally {
      try { this.reader.releaseLock(); } catch {}
      this.reader = null;
      if (this.onDisconnect) this.onDisconnect();
    }
  }
}
