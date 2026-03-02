# Architecture (V1)

## Goal
A local-first Windows desktop assistant for live meetings with:

- English transcript (remote + self)
- Turkish translation of remote speech
- Context-aware short reply suggestions in EN + TR
- Dual-window UI (control + transparent overlay)

## Runtime Components

1. Electron Main Process
- Window lifecycle (control + overlay)
- IPC orchestration
- Session control and state fanout
- STT worker bridge (Python subprocess)
- Local LLM orchestration via Ollama HTTP API

2. Python STT Worker (`scripts/stt_worker.py`)
- Accepts NDJSON commands from stdin
- Buffers PCM16 chunks by speaker channel
- Uses silence gating + faster-whisper transcription
- Emits transcript events on stdout (NDJSON)

3. Renderer (React)
- Control window: session controls, model settings, source selection, transcript/assist logs
- Overlay window: transparent live card with EN transcript + TR translation + EN/TR suggestion
- Captures system+microphone audio and ships chunks to main process

## Data Flow

1. Renderer captures audio on two channels:
- `remote`: system audio stream (meeting participants)
- `self`: microphone stream (user voice)

2. Main forwards audio chunks to STT worker:
- `audio:chunk -> sttBridge -> worker stdin`

3. Worker emits transcript final events:
- `worker stdout -> sttBridge -> ipc broadcast transcript:final`

4. For `remote` final transcript, main calls AssistService:
- Builds short context from rolling transcript history
- Calls Ollama `/api/chat` with strict JSON output contract
- Streams partial raw output, then emits structured final assist payload

5. Renderer updates:
- Control window logs full stream
- Overlay shows latest remote sentence and matched assist card

## Privacy Model

- Default local-only processing
- No cloud API key required
- Settings stored locally; sensitive text fields encrypted if `safeStorage` is available
- History persistence is opt-in design target (V1 stores in-memory)
