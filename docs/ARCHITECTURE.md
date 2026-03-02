# Architecture (V1.3)

## Goal
A local-first Windows desktop assistant for live meetings with:

- English transcript (remote + self)
- Turkish translation of remote speech
- Context-aware short reply suggestions in EN + TR
- Dual-window UI (control + transparent overlay)

## Runtime Components

1. Electron Main Process
- Window lifecycle (control + overlay)
- IPC orchestration and runtime state fanout
- Session phase/state machine (`idle -> starting -> running -> ...`)
- STT worker bridge (Python subprocess with ready handshake)
- Local LLM orchestration via Ollama HTTP API
- Rolling latency metrics aggregator (`stt_first_chunk`, `assist_first_token`, `assist_final`, `worker_error_rate`)
- Encrypted history persistence + export manager (opt-in, local disk)

2. Python STT Worker (`scripts/stt_worker.py`)
- Accepts NDJSON commands from stdin
- Buffers PCM16 chunks by speaker channel
- Uses per-channel silence/RMS gating and faster-whisper transcription
- Supports runtime VAD updates (`update_vad`)
- Emits `ready`, `transcript`, `diagnostics`, and `error` events on stdout (NDJSON)

3. Renderer (React)
- Control window: session controls, model settings, source selection, VAD tuning, diagnostics panel, transcript/assist logs
- Overlay window: transparent live card with EN transcript + TR translation + EN/TR suggestion
- Captures system+microphone audio and ships chunks to main process
- Auto-recovery for system source disconnect (retry + fallback source switch)

## Data Flow

1. Renderer captures audio on two channels:
- `remote`: system audio stream (meeting participants)
- `self`: microphone stream (user voice)

2. Main forwards audio chunks to STT worker when session is `running`:
- `audio:chunk -> sttBridge -> worker stdin`

3. Session start uses worker readiness handshake:
- `session:start -> start_session(vad) -> worker ready -> phase running`

4. Worker emits transcript and diagnostics events:
- `worker stdout -> sttBridge -> ipc broadcast`

5. For `remote` final transcript, main calls AssistService:
- Builds short context from rolling transcript history
- Calls Ollama `/api/chat` with strict JSON output contract
- Streams partial raw output, then emits structured final assist payload
- Uses timeout + cancellation to avoid stale assist buildup
- Applies confidence heuristics and optional fallback prompt path when primary parse/quality is weak

6. Renderer updates:
- Control window logs full stream
- Overlay shows latest remote sentence and matched assist card
- Overlay runtime state is synced from main via `overlay:state`
- Diagnostics panel merges capture health + worker diagnostics
- Latency dashboard renders p50/p95 from `metrics:latency`

7. History + export:
- Session transcript/assist records are accumulated in main process during runtime
- If `historyOptIn=true` and secure storage is available, session snapshots are encrypted and persisted under app userData
- `history:export` produces JSON or Markdown exports under app userData export directory

## Benchmarking

- `scripts/benchmark_runner.py` executes repeatable STT+assist latency runs against fixed clips in `benchmark/clips/manifest.json`.
- Output reports are written to `benchmark/reports/*.json` with p50/p95 summaries.

## Packaging Notes

- Production packaging uses `electron-builder` with `asar` enabled.
- Installer target is Windows NSIS x64.
- `scripts/stt_worker.py` is shipped as an external runtime resource (`extraResources`).

## Privacy Model

- Default local-only processing
- No cloud API key required
- Settings stored locally; sensitive text fields encrypted if `safeStorage` is available
- Session history persistence is opt-in and encrypted when `safeStorage` is available
