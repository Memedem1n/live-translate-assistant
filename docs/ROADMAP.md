# Roadmap

## Milestone 0 - Bootstrap (done in this iteration)
- [x] Electron + React + TypeScript skeleton
- [x] Dual-window app shell
- [x] IPC contracts and settings manager
- [x] Python STT worker bridge
- [x] Local Ollama assist service contract
- [x] Core docs bundle

## Milestone 1 - Audio Reliability
- [ ] Add per-channel VAD tuning controls
- [ ] Add source diagnostics panel (level meter, dropped chunk count)
- [ ] Add auto-recovery for device reconnect

## Milestone 2 - Quality + Latency
- [ ] Add benchmark runner with repeatable test clips
- [ ] Optimize prompt for strict JSON compliance
- [ ] Add p50/p95 latency dashboard
- [ ] Add confidence heuristics with fallback prompt path

## Milestone 3 - History + Export
- [ ] Encrypted opt-in history persistence
- [ ] Session export (JSON/Markdown)
- [ ] Search and filters in control panel

## Milestone 4 - Packaging
- [ ] Harden production build assets
- [ ] Add Windows installer pipeline
- [ ] Add update strategy + release checklist
