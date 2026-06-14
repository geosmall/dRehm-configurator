/**
 * @file tabs/status.js
 * @brief Status tab — armed state, cycle time, CPU load, attitude, analog
 */

import { MSP, readU8, readU16, readS16, readU32 } from '../msp.js';
import { setText, sensorString } from '../util.js';
import { createInstrument } from '../instruments.js';

// Lazily-created flight instruments (artificial horizon + heading).
let attitudeInst = null;
let headingInst = null;

function ensureInstruments() {
  if (attitudeInst) return;
  const a = document.getElementById('inst-attitude');
  const h = document.getElementById('inst-heading');
  if (a) attitudeInst = createInstrument(a, 'attitude', { size: 130 });
  if (h) headingInst = createInstrument(h, 'heading', { size: 130 });
}

/** Handle incoming MSP messages for the Status tab */
export function handleStatusMessage(msg) {
  switch (msg.cmd) {

    case MSP.STATUS: {
      const cycleTime = readU16(msg.payload, 0);
      const cpuLoad   = readU16(msg.payload, 2);
      const sensors   = readU16(msg.payload, 4);
      const flags     = readU32(msg.payload, 6);
      const armed     = (flags & 1) !== 0;

      setText('val-armed', armed ? 'YES' : 'NO');
      const el = document.getElementById('val-armed');
      if (el) {
        el.classList.toggle('armed', armed);
        el.classList.toggle('disarmed', !armed);
      }
      setText('val-cycletime', cycleTime + ' \u00B5s');
      setText('val-cpuload', cpuLoad + '%');
      setText('val-sensors', sensorString(sensors));
      break;
    }

    case MSP.ATTITUDE: {
      const roll  = readS16(msg.payload, 0) / 10;
      const pitch = readS16(msg.payload, 2) / 10;
      const yaw   = readS16(msg.payload, 4);

      setText('val-roll', roll.toFixed(1) + '\u00B0');
      setText('val-pitch', pitch.toFixed(1) + '\u00B0');
      setText('val-yaw', yaw + '\u00B0');

      ensureInstruments();
      if (attitudeInst) { attitudeInst.setRoll(roll); attitudeInst.setPitch(pitch); }
      if (headingInst) headingInst.setHeading(yaw);
      break;
    }

    case MSP.ANALOG: {
      const vbat = readU8(msg.payload, 0);
      const rssi = readU16(msg.payload, 3);

      setText('val-vbat', vbat > 0 ? (vbat / 10).toFixed(1) + ' V' : 'N/A');
      setText('val-rssi', rssi > 0 ? rssi : 'N/A');
      break;
    }
  }
}