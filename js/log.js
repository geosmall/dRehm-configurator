/**
 * @file log.js
 * @brief INAV-style collapsible log panel
 *
 * Timestamped event log between header and main content.
 * Toggle with Show/Hide Log button.
 */

const MAX_ENTRIES = 200;
let logContent = null;

function timestamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10) + ' @ ' + d.toTimeString().slice(0, 8);
}

/** Initialize log panel DOM and toggle button */
export function initLog() {
  logContent = document.getElementById('log-content');
  const panel = document.getElementById('log-panel');
  const toggle = document.getElementById('log-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      toggle.textContent = collapsed ? 'Show Log' : 'Hide Log';
    });
  }
}

/** Append a timestamped message to the log panel */
export function log(msg) {
  const line = `${timestamp()} -- ${msg}`;
  if (logContent) {
    const div = document.createElement('div');
    div.textContent = line;
    logContent.appendChild(div);
    if (logContent.children.length > MAX_ENTRIES) {
      logContent.removeChild(logContent.firstChild);
    }
    logContent.scrollTop = logContent.scrollHeight;
  }
}
