# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are driven by the `version` field in `package.json`: bump it on `main` and
push, and `.github/workflows/publish.yml` tags the commit, creates the GitHub release
using the matching section below, and publishes to npm. A release will **fail** if
this file has no `## [x.y.z]` section for the version being released.

## [0.2.0] - YYYY-MM-DD

### Added

- HomeKit support for the Philips CX3550/01 fan using a native
  Fan service, with power, three manual speeds, and oscillation.
- Opt-in Sleep and Natural Breeze switches. Turning either mode off returns the
  fan to its previous manual speed.

### Notes

Behaviour confirmed against a CX3550/01 that differs from what the published
device registries describe:

- Fan speed is selected through `D0310C`; `D0310D` is treated as reported state
  rather than written as part of a speed change.
- Oscillation is enabled by writing `17242`, while enabled status can report a
  different non-zero value. Any non-zero reported value is therefore treated as
  enabled.
- The fan may establish a status observation without immediately publishing an
  initial snapshot. The plugin uses a bounded bootstrap mechanism to obtain that
  state when required.
- Long periods without status updates are normal for this fan. Rather than treating
  silence itself as a failure, the plugin refreshes the existing observation and
  probes device reachability after a model-specific quiet interval, escalating to
  observation re-registration and reconnect only when recovery checks fail. Normal
  status updates remain event-driven rather than polled.
- Malformed same-token Observe packets that are not encrypted status payloads
  are ignored instead of terminating an otherwise healthy observation.

## [0.1.0] - 2026-07-31

First release.

### Added

- HomeKit support for Philips air purifiers over the local, encrypted CoAP API.
  The CoAP stack, the AES-128-CBC encryption and the device registry are all
  implemented in TypeScript in this plugin — **no Python, no cloud service, and no
  third-party CoAP dependency**, so installation is a plain `npm install` with no
  install scripts.
- Air Purifier service with power, fan speed and Auto/Manual, plus Air Quality
  (from PM2.5), Temperature, Humidity, and Pre-filter / NanoProtect filter life.
- Opt-in Display light, Sleep, Auto+ AI and Beep controls.
- A custom configuration UI that scans the local network on open and adds a
  discovered purifier in one click. Nothing needs to be typed into a JSON file.
- Automatic reconnection with backoff. The device API uses non-confirmable CoAP,
  which has no retransmission, so a single dropped datagram is normal and must not
  strand a device — a purifier that misses its first response is retried rather
  than dropped until Homebridge restarts.
- Support for 62 models across the Gen1, Gen2 and Gen3 device APIs.

### Notes

Behaviour confirmed against an AC4220/12 that differs from what the published
device registries describe:

- `D03105` is a **read-only** status mirror — writes are acknowledged and silently
  discarded. The writable display-light control is `D03135`. Models with no known
  writable light key therefore expose no Lightbulb rather than one that appears to
  work and does nothing.
- Beep is a boolean stored as **0 / 100**, not 0 / 1.
- Speed 5 is Turbo, not a distinct mode, so no separate Turbo switch is exposed.
