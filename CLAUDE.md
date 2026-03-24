# dRehm-configurator — Development Guide

## Local Development

```bash
# From the workspace root:
python3 -m http.server 8080 -d dRehm-configurator
```

Then open http://localhost:8080 in Chrome/Edge.

- **Port**: Always use **8080**
- **WebSerial** requires `localhost` or HTTPS — `file://` URLs will not work
- No build step — vanilla JS + ES modules, edit and reload

## Architecture

| File | Role |
|------|------|
| `js/app.js` | Entry point — connection, tab switching, MSP polling, CLI mode switching |
| `js/serial.js` | Web Serial API wrapper (port scan, connect, read/write, reconnect) |
| `js/msp.js` | MSP V1 encoder/decoder, message dispatch |
| `js/cli.js` | CLI mode protocol (enter/exit, banner validation, reboot detection) |
| `js/util.js` | Shared helpers (setText, sleep, sensorString) |
| `js/tabs/*.js` | Per-tab handlers (status, receiver, sensors, terminal) |
| `css/style.css` | All styles |
| `index.html` | Single-page app shell |
| `sw.js` | Service worker for offline PWA |

## Protocols

- **MSP V1** (binary): FC → PWA telemetry polling. Command codes in `msp.js`.
- **CLI** (text): PWA → FC parameter tuning. `#` enters CLI, `exit` soft-returns to MSP.
- Mode switching managed by `cli.js` — `enterCli()` / `exitCli()` handle the full protocol.

## Service Worker Cache

`sw.js` uses a cache-first strategy. The browser serves cached JS/CSS unless `CACHE_VERSION` changes.

- **During development**: Bump `CACHE_VERSION` in `sw.js` on every change, then Ctrl+Shift+R to reload. Without this, the browser serves stale cached code.
- **On release**: Reset `CACHE_VERSION` to `'drehm-v1'` for a clean starting point.
- **DevTools shortcut**: F12 → Application → Service Workers → check "Update on reload" to auto-bypass cache during a dev session.

## Testing Changes

1. Start local server on port 8080 (see above)
2. Bump `CACHE_VERSION` in `sw.js` if any JS/CSS/HTML changed
3. Ctrl+Shift+R to reload
4. Connect to FC via WebSerial
5. Test the specific tab/feature you changed
