/**
 * @file util.js
 * @brief Shared helpers for dRehmFlight PWA Configurator
 */

/** Set element text by ID */
export function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** Format sensor bitmask to human-readable string */
export function sensorString(mask) {
  const names = [];
  if (mask & 0x01) names.push('ACC');
  if (mask & 0x02) names.push('BARO');
  if (mask & 0x04) names.push('MAG');
  if (mask & 0x08) names.push('GPS');
  if (mask & 0x10) names.push('GYRO');
  return names.length ? names.join(' ') : 'NONE';
}

/** Sleep for ms (for mode-switch timing) */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
