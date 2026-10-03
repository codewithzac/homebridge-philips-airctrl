# Homebridge Philips Air Purifier

[![npm](https://img.shields.io/npm/v/homebridge-philips-airctrl/latest?label=latest)](https://www.npmjs.com/package/homebridge-philips-airctrl)
[![GitHub release](https://img.shields.io/github/release/ruaan-deysel/homebridge-philips-airctrl.svg)](https://github.com/ruaan-deysel/homebridge-philips-airctrl/releases)
[![npm](https://img.shields.io/npm/dt/homebridge-philips-airctrl)](https://www.npmjs.com/package/homebridge-philips-airctrl)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

HomeKit support for Philips air purifiers and supported fans over their local,
encrypted CoAP API.

**No Python. No cloud. No third-party CoAP library.** The protocol — CoAP framing,
the AES-128-CBC encryption, the device key registry — is implemented in TypeScript
inside this plugin, so installing it is a plain `npm install` with no system
dependencies and no install scripts.

## Why another Philips plugin

Existing Homebridge plugins for these purifiers bundle the Python `aioairctrl`
library and shell out to it, which means a Python runtime, install scripts, and a
setup that breaks whenever the host Python changes. This plugin is a direct port of
[philips-airctrl](https://github.com/ruaan-deysel/philips-airctrl) to TypeScript,
with the device model registry from
[ha-philips-airpurifier](https://github.com/ruaan-deysel/ha-philips-airpurifier).

## Requirements

- Homebridge 2.0 or newer
- Node.js 22.12+ or 24+
- A supported Philips air purifier or fan on your local network that speaks the
  CoAP API (port 5683)

## Setup

Install the plugin, then open its settings in the Homebridge UI. The panel scans
your network automatically and lists any supported devices it finds — click
**Add**. There is no JSON to edit.

If a device is not found (some networks block the subnet sweep), type its IP into
**Device IP** and click **Add**.

## What you get in HomeKit

| Service | Notes |
| --- | --- |
| Air Purifier | On/off, fan speed, and Auto/Manual |
| Fan | On/off, fan speed, and oscillation on supported fan models |
| Air Quality Sensor | Derived from PM2.5 |
| Temperature Sensor | If the model reports it |
| Humidity Sensor | If the model reports it |
| Filter Maintenance | Pre-filter and NanoProtect life, with change indication |
| Lightbulb | Display light, on models with a writable light control |
| Switch | Sleep mode, Natural Breeze, Auto+ AI, and Beep — each opt-in |

Optional services appear only when the configured model supports them.

## Configuration

Everything is set from the UI. Each device has:

- **IP Address** — required
- **Name** — defaults to the name the device reports
- **Display light**, **Sleep switch**, **Natural Breeze switch**,
  **Auto+ AI switch**, **Beep switch** — opt-ins

The CoAP port defaults to 5683 and is only settable via the JSON config editor,
since it never differs on stock firmware.

## Notes on device behaviour

A few things this plugin handles that are easy to get wrong, all confirmed against
real hardware:

- `D03105` is a **read-only** status mirror. Writes are acknowledged and silently
  discarded. The writable display-light control is `D03135`.
- Beep is a boolean stored as **0 / 100**, not 0 / 1.
- Speed 5 is Turbo — it is not a separate mode.

The device API uses non-confirmable CoAP messages, which have no retransmission, so
a dropped packet is normal. The plugin retries with backoff rather than treating a
single lost datagram as a missing device.

## Licence

MIT © Ruaan Deysel
