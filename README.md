<p align="center">
  <img src="icons/icon-192.png" alt="dRehmFlight" width="96">
</p>

<h1 align="center">dRehmFlight Configurator</h1>

<p align="center">
  A lightweight PWA for configuring <a href="https://github.com/nickrehm/dRehmFlight">dRehmFlight VTOL</a> flight controllers via Web Serial.
</p>

<p align="center">
  <a href="https://geosmall.github.io/dRehm-configurator/">Open Configurator</a>
</p>

---

## Features

- **Status** — Armed state, cycle time, CPU load, attitude, battery
- **Receiver** — 6 RC channel bars with live values
- **Sensors** — Scrolling oscilloscope-style graphs for gyro, accelerometer, and magnetometer with selectable scale and refresh rate
- **CLI Terminal** — Full command-line interface with command history
- **Settings Editor** — Grouped PID/filter parameter form with dirty tracking and save-only-changed

## Requirements

- **Browser**: Chrome or Edge (Web Serial API)
- **Firmware**: dRehmFlight STM32 1.3b with MSP V1 + CLI support
- **Connection**: USB serial at 115,200 baud

## Usage

1. Open the [Configurator](https://geosmall.github.io/dRehm-configurator/) in Chrome or Edge
2. Connect your flight controller via USB
3. Click **Connect** and select the serial port
4. Use the sidebar tabs to monitor telemetry or tune parameters

The app works offline after first load and can be installed as a standalone app from the browser menu.

## Architecture

Vanilla JS + ES modules, no build step, no dependencies. Communicates with the flight controller over two protocols:

| Protocol | Direction | Purpose |
|----------|-----------|---------|
| MSP V1 (binary) | FC → PWA | Telemetry polling (status, RC, sensors, attitude) |
| CLI (text) | PWA → FC | Parameter tuning, flash management, settings |

Mode switching: `#` enters CLI mode, `exit` returns to MSP telemetry.

## Development

```bash
# Serve locally
cd drehm-pwa
python3 -m http.server 8080
# Open http://localhost:8080 in Chrome/Edge
```

## License

Part of the [dRehmFlight](https://github.com/nickrehm/dRehmFlight) project.
