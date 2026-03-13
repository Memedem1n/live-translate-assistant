# Interview Copilot

Interview Copilot is a local-first Windows desktop copilot for live software-engineering interviews.

## V1 scope

- Captures interviewer and candidate audio in real time
- Produces English-first transcripts for live technical interviews
- Generates first-person English answer suggestions grounded in candidate context
- Optionally shows Turkish helper translations without blocking the main answer path
- Runs locally by default with `faster-whisper` and Ollama-compatible inference
- Uses a two-window interface: control panel + transparent overlay
- Persists session history locally with opt-in encryption
- Exports full interview sessions to JSON or Markdown for review and future training

## Runtime defaults

- Primary inference candidate: `llama3.1:8b-instruct-q4_K_M`
- Latency fallback: `qwen2.5:7b-instruct-q4_K_M`
- Naturalness challenger: `mistral:7b-instruct-v0.3-q4_K_M`
- Helper translation model: `qwen2.5:3b-instruct-q4_K_M`
- STT default: `medium.en`
- STT quality candidate: `large-v3-turbo`

## Quick start

1. Install prerequisites:
   - Node.js 20+
2. Install Windows runtime dependencies:
   - `npm run runtime:setup`
3. Verify CUDA and local runtime health:
   - `npm run runtime:probe`
4. Pull the local model bundle:
   - `npm run models:pull`
5. Install app dependencies:
   - `npm install`
6. Start the app:
   - `npm run dev`

## Benchmark flow

1. Prepare sample clips:
   - `npm run clips:prepare`
2. Preload STT assets:
   - `npm run stt:prewarm`
3. Run the latency and quality sweep:
   - `npm run benchmark:sweep`
4. Run the end-to-end demo pipeline:
   - `npm run demo:pipeline`
5. Review reports in `benchmark/reports/`.
6. Promotion decisions should use `summary.warm_gate`.

## Training and personalization flow

1. Sync the curated interview/web corpus:
   - `npm run corpus:sync`
   - higher quality preset: `npm run corpus:sync:quality`
2. Import external interview QA datasets:
   - `npm run corpus:import:external`
3. Build the interview glossary:
   - `npm run glossary:build`
4. Build train/valid fine-tune datasets:
   - `npm run finetune:dataset`
5. Run dataset quality checks:
   - `npm run finetune:quality-check`
6. Recommended Windows-native HF LoRA path:
   - `npm run finetune:hf:setup-env`
   - `npm run finetune:hf:check-env`
   - `npm run finetune:hf:prepare`
   - `npm run finetune:hf:smoke`
   - `npm run finetune:hf:full`
   - `npm run finetune:hf:package-ollama`
7. Export a clean remote/Colab bundle when needed:
   - `npm run finetune:export-bundle`

## Session history

1. Enable `History Opt-In` in the control panel.
2. Run an interview session and stop it.
3. Use the history/export controls to export JSON or Markdown.
4. Exports are written to the app `userData/exports/` directory.

## Packaging

- Installer build:
  - `npm run build:win`
- Unpacked directory build:
  - `npm run build:win:dir`
- Icon asset generation:
  - `npm run asset:icon`
- Code-signing readiness check:
  - `npm run codesign:check`

## Default hotkeys

- `Ctrl+Shift+O`: Toggle overlay
- `Ctrl+Shift+M`: Mute suggestions
- `Ctrl+Shift+H`: Panic hide overlay

## Docs

- `docs/ARCHITECTURE.md`
- `docs/API_SPEC.md`
- `docs/PERFORMANCE_PLAN.md`
- `docs/MODEL_SETUP_TR.md`
- `docs/DATASET_SOURCE_AUDIT_TR.md`
- `docs/PRIVACY_TR.md`
- `docs/CODE_SIGNING_TR.md`
