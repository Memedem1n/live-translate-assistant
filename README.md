# LiveTranslate Assistant

LiveTranslate Assistant is a local-first Windows desktop copilot for live meetings.

## What V1 does

- Captures live conversation context (remote + self tracks)
- Produces multi-language transcript (TR/EN auto) and Turkish translation
- Generates short context-aware reply suggestions in both EN and TR
- Runs with local models by default (Ollama + faster-whisper)
- Uses dual-window UI: control panel + transparent overlay
- Supports opt-in encrypted session history
- Supports session export to JSON / Markdown
- Uses minimal control panel UX with automatic system-audio capture default

## Quick start

1. Install prerequisites:
   - Node.js 20+
2. Install runtime dependencies (Windows, recommended stable path):
   - `npm run runtime:setup`
3. Verify CUDA/runtime health (recommended):
   - `npm run runtime:probe`
4. Pull local answer model set (full profile):
   - `npm run models:pull`
5. Install app dependencies:
   - `npm install`
6. Run dev app:
   - `npm run dev`

## Model footprint (selected demo package)

- `qwen2.5:3b-instruct-q4_K_M`: ~1.9 GB
- `qwen2.5:7b-instruct-q4_K_M`: ~4.7 GB
- `qwen2.5:14b-instruct-q4_K_M`: ~9.0 GB
- `small.en` (faster-whisper): ~0.48 GB
- `medium.en` (faster-whisper): ~1.53 GB
- `large-v3` (faster-whisper): ~3.09 GB
- Model total: ~20.7 GB (practical disk use with cache: ~21-22 GB)

## Benchmark and demo

1. Prepare public sample clips:
   - `npm run clips:prepare`
2. Preload STT model files:
   - `npm run stt:prewarm`
3. Run latency model sweep:
   - `npm run benchmark:sweep`
4. End-to-end demo pipeline (steps 1-3 together):
   - `npm run demo:pipeline`
5. Check JSON reports in `benchmark/reports/`.
6. Latency gate decisions should use `summary.warm_gate`.

## Personalization pipeline (RAG + LoRA prep)

1. Build web corpus:
   - `npm run corpus:sync`
2. Build interview glossary:
   - `npm run glossary:build`
3. Build train/valid fine-tune dataset:
   - `npm run finetune:dataset`
4. Prepare local LoRA training environment (separate venv):
   - `npm run finetune:setup-env`
5. Check local LoRA training environment:
   - `npm run finetune:check-env`
6. Prepare/run LoRA training command template:
   - `npm run finetune:prepare-lora`
   - optional smoke run: `npm run finetune:prepare-lora:smoke`
7. Package adapter for Ollama (after training):
   - `npm run finetune:package-ollama`

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
- `docs/MODEL_SETUP_TR.md`
- `docs/EOD_2026-03-03_TR.md`
- `docs/EOD_2026-03-04_TR.md`
- `docs/PRIVACY_TR.md`
- `docs/CODE_SIGNING_TR.md`
- `docs/RELEASE_STRATEGY.md`
- `docs/UI_GUIDELINES_TR.md`
