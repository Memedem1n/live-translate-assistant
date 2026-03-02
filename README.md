# LiveTranslate Assistant

LiveTranslate Assistant is a local-first Windows desktop copilot for live meetings.

## What V1 does

- Captures live conversation context (remote + self tracks)
- Produces English transcript and Turkish translation
- Generates short context-aware reply suggestions in both EN and TR
- Runs with local models by default (Ollama + faster-whisper)
- Uses dual-window UI: control panel + transparent overlay

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
- `docs/UI_GUIDELINES_TR.md`
