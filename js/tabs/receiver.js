/**
 * @file tabs/receiver.js
 * @brief Receiver tab — 6 RC channel bars with live PWM values
 */

import { MSP, readU16 } from '../msp.js';
import { setText } from '../util.js';

const PWM_MIN = 1000;
const PWM_MAX = 2000;

/** Handle incoming MSP_RC messages */
export function handleReceiverMessage(msg) {
  if (msg.cmd !== MSP.RC) return;

  for (let i = 0; i < 6; i++) {
    const pwm = readU16(msg.payload, i * 2);
    const pct = Math.max(0, Math.min(100, ((pwm - PWM_MIN) / (PWM_MAX - PWM_MIN)) * 100));

    setText(`rc-val-${i}`, pwm);
    const fill = document.getElementById(`rc-fill-${i}`);
    if (fill) fill.style.width = pct + '%';
  }
}
