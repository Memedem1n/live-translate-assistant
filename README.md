# LiveTranslate Assistant

LiveTranslate Assistant is a local-first Windows desktop copilot for live meetings.

## What V1 does

- Captures live conversation context (remote + self tracks)
- Produces English transcript and Turkish translation
- Generates short context-aware reply suggestions in both EN and TR
- Runs with local models by default (Ollama + faster-whisper)
- Uses dual-window UI: control panel + transparent overlay
- Supports opt-in encrypted session history
- Supports session export to JSON / Markdown
- Includes control-panel search and filtering for transcript/assist streams

## Quick start

1. Install prerequisites:
   - Node.js 20+
   - Python 3.10+
   - Ollama
2. Pull a local answer model:
   - `ollama pull qwen2.5:7b-instruct-q4_K_M`
3. Install Python STT dependency:
   - `pip install faster-whisper`
4. Install app dependencies:
   - `npm install`
5. Run dev app:
   - `npm run dev`

## Benchmark

1. Add fixed clips to `benchmark/clips/manifest.json`.
2. Run benchmark:
   - `npm run benchmark`
3. Check JSON report in `benchmark/reports/`.

## History and export

1. Enable `History Opt-In` in Control panel and click `Save Settings`.
2. Run a session and stop it.
3. In `History & Export`, use:
   - `Refresh History` to list persisted sessions
   - `Export Current JSON` / `Export Current Markdown`
   - Per-session JSON/Markdown export buttons
4. Exports are written to app `userData/exports/`.

## Packaging (Windows)

- Local installer build:
  - `npm run build:win`
- Unpacked directory build:
  - `npm run build:win:dir`
- Icon asset generation:
  - `npm run asset:icon`
  - output: `build/icon.ico`
- Code-signing readiness check:
  - `npm run codesign:check`
- CI installer pipeline:
  - `.github/workflows/windows-installer.yml`
  - Triggered by `v*` tag pushes or manual dispatch.
  - Signing is optional; without secrets installer is built unsigned.
  - Optional signing secrets:
    - `WINDOWS_CERT_PFX_BASE64`
    - `WINDOWS_CERT_PASSWORD`
  - Setup guide: `docs/CODE_SIGNING_TR.md`

## Default hotkeys

- `Ctrl+Shift+O`: Toggle overlay
- `Ctrl+Shift+M`: Mute/Unmute suggestions
- `Ctrl+Shift+H`: Panic hide overlay

## Documentation

- `docs/ARCHITECTURE.md`
- `docs/API_SPEC.md`
- `docs/ROADMAP.md`
- `docs/PERFORMANCE_PLAN.md`
- `docs/PRIVACY_TR.md`
- `docs/CODE_SIGNING_TR.md`
- `docs/RELEASE_STRATEGY.md`
- `docs/UI_GUIDELINES_TR.md`
