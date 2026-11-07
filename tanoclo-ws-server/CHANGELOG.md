# Changelog

All notable changes to the **TaNoClo WebSocket Server** Home Assistant App will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-11-07

- fix(energy): safely resolve readings array from API response object
- fix: isolate capture sessions and retain Block2 representation metadata
- fix(energy): resolve TDZ ReferenceError on energySettings in GasEnergySection
- feat(energy): add historical monthly gas readings, bulk setup & reading log
- docs: clarify capture readiness and align comments and tests with project style
- fix: capture complete and multipart Block2 configuration responses
- feat(energy): add gas usage, costs, DHW split & MQTT ingestion
- fix(test): restore pool.execute after test_device_role_switching
- fix(mold-detector): fix VTT growth rate formula and correlate historical weather
- fix(test): fix CI test isolation and fixture seeding for api routes and config sync
- fix(ci): run migrations in CI, add template home fixture, and ensure log dir
- fix(ci): track ws-server/check.js for CI Acorn AST validation
- fix(ci): fix MariaDB COMMENT syntax in tanoclo.sql and ESLint in pidPresets
- feat(zones): add room size and instant PID presets
- feat(heating): auto-derive underfloor presence and remove legacy UI toggle
- ci: add GitHub Actions test workflow and fix lint
- feat(zones): add per-room underfloor heating and auto-assist integration - Add heating_type and underfloor_mass to zones schema and API - Clamp flow temperature ceiling to 45C when UFH active - Separate radiator and UFH cohorts in hydraulic balancing - Calibrate PID suggestions with UFH gain clamping and preset - Scale early start lookahead dynamically for high slab thermal lag - Add schedule advisory engine for slab setbacks and inertia - Expose emitter configuration, indicators, and advisories in UI
- feat(airComfort): add mold detection and insulation factor
- fix(ws-server): isolate bridge pacing and db in tests
- fix(circuit): suppress 0x2040 in standby mode

## [0.8.4] - 2026-10-24

- feat(telemetry): upsert and merge circuit measurements
- fix(mesh): recover link loss fast and pace bridge downlink
- fix(frontend): format supply temp times in home timezone
- chore: update node to v26
- chore: update node_modules

## [0.8.3] - 2026-10-19

- fix(cmd-api): drain the REST API child's sleepy-downlink queue on device wake
- fix: release/ota workflow

## [0.8.2] - 2026-10-16

- feat: Improve Thermodynamic and hydraulic balancing

## [0.8.1] - 2026-10-15

- feat: Improve PID/Balancing
- fix(config): Stop using last_config_json to fix device/zone/circuit/hvac configs

## [0.8.0] - 2026-10-12

- fix: various
- refactor(emulator): update PID tick and schedule profile evaluation
- fix(concurrency): add DB unique constraints, frontend click locks, and copySchedule lock ordering
- feat(overlay): port overlay mode harmonization, presets and atomic schedule locking
- docs: Align docs and OpenAPI with recent changes
- feat: Add schedule profiles
- feat: Add thermodynamic balancing
- feat: Add queue for commands to sleepy devices

## [0.7.2] - 2026-10-11

- audit recent changes

## [0.7.1] - 2026-10-10

- fix: PID/Advanced heating parameters
- feat: Improve zone advanced page
- feat: Improve debug device settings
- feat: Add custom battery curves
- feat: Add hydraulic balancing

## [0.7.0] - 2026-10-09

- feat: Improve zone advanced page
- feat: Improve debug device settings
- feat: Add custom battery curves
- feat: Add hydraulic balancing

## [0.6.0] - 2026-10-09

- feat: add more FIDs
- feat: Add translations to admin/setup portal
- feat: add valve sensitivity
- feat: auto flow temp optimization
- feat: improve emulator

## [0.5.2] - 2026-10-08

- fix: zone overlays, setpoint handling and bindings
- fix: emulator CoAP

## [0.5.1] - 2026-10-07

- fix: etag handling of zone config

## [0.5.0] - 2026-10-05

- feat: add circuit measurements
- feat: prevent RF congestion, fix: etag handling
- feat: add mesh recovery logic
- feat: Show hardware errors on Home view
- fix(patch_ib_firmware): address review feedback
- fix: frontend-new icons missing
- docs(patch_ib_firmware): macOS setup, dump verification, Tag-Connect footprint
- fix(patch_ib_firmware): compare RootCA by DER hash, not PEM with CRLF
- fix(patch_ib_firmware): eliminate stub status race in SPI dump/program; verify reads
- fix(patch_ib_firmware): macOS/BSD userland portability
- chore(patch_ib_firmware): commit shell scripts with the executable bit

## [0.4.0] - 2026-09-21

- fix: more critical issues in device/zone/circuit config generation/processing and wireless sensor emulator
- feat: Improve SSE for concurrency
- fix: fix critical issue that prevents producing valid configs
- security: block access to commandApi from remote sources
- fix: set modulePreload to false in frontend-new
- fix: config generation

## [0.3.4] - 2026-09-20

- fix: fix issues found after audit based improvements
- feat: audit based improvements to ws-server

## [0.3.3] - 2026-09-20

- fix: fix issues found after audit based improvements
- feat: audit based improvements to ws-server

## [0.3.2] - 2026-09-15

- fix: prevent logout on language change
- fix: caching issues with workflows

## [0.3.1] - 2026-09-12

- feat: Improve translations
- fix: native login
- fix: Docker build

## [0.3.0] - 2026-09-12

- feat/fix/docs: full audit
- feat: various improvements to ws-server
- feat: Improve Tado emulation

## [0.2.12] - 2026-09-07

- fix: energy and openapi
- feat: Auto version in Github actions
- feat: Improve Tado emulation

## [0.2.11] - 2026-09-04

- feat: Improve Tado emulation
- feat/fix: Improve OTA, emulator and device/zone settings
- feat/fix: Improve OTA, emulator and device/zone settings

## [0.2.10] - 2026-08-30

- feat: Release notes, improve emulator and sniffer, improve mobile view, improve OpenAPI

## [0.2.9] - 2026-08-28

- feat: Improve OTA updating
- fix: Android updater
- feat: WS MID deduplication
- feat: Improve SSE
- fix: Fix pairing of real devices
- feat: Add Carto API key
- feat: improve emulator
- feat: improve emulator

## [0.2.8] - 2026-08-27

- feat: Emulated devices improvements
- fix: CHANGELOG.md generation, Github actions and confirm modal
- fix: zone bindings and RU role change

## [0.2.7] - 2026-08-26

- feat/fix: Audit and advanced device settings improvements

## [0.2.6] - 2026-08-25

- fix: zone config peers
- docs: Add screenshots
- feat: Improve IAQ language

## [0.2.5] - 2026-08-24

- docs: rewrite all docs
- chore: npm audit

## [0.2.4] - 2026-08-23

- fix: battery and telemetry fixes
- fix: Zone and emulator fixes

## [0.2.3] - 2026-08-23

- fix: Zone and emulator fixes
- fix: Fix raw explorer and emulator code
- fix: fw state updates
- feat: concurrency queue

## [0.2.2] - 2026-08-20

- feat: Improve Tado emulation
- fix: Path classification
- feat: Working Tado emulation
- feat: Prevent workflows running concurrently

## [0.2.1] - 2026-08-17

- fix: Fix test issues
- fix: Prevent fallback to IB from other home
- fix: Improve IAQ, Tado emulation

## [0.2.0] - 2026-08-15

- Initial commit