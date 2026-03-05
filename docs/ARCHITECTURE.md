# Architecture

## Goal

Build a local-first desktop copilot for live software-engineering interviews with:

- English-first live transcripts
- First-person interview answers grounded in candidate context
- Optional Turkish helper translation
- Fast local inference with a clean provider abstraction
- Session capture for later review, fine-tuning, and evaluation

## Runtime components

### 1. Electron main process

- Owns the window lifecycle for control and overlay surfaces
- Owns IPC orchestration and live session state
- Starts and supervises the Python STT worker
- Routes final remote transcript segments into the interview answer pipeline
- Tracks latency metrics for transcript, first token, and final answer
- Persists encrypted session history when enabled

### 2. Python STT worker

File: `scripts/stt_worker.py`

- Accepts NDJSON commands over stdin
- Buffers PCM16 audio for `remote` and `self`
- Uses `faster-whisper` for transcription
- Performs eager warmup and CUDA fallback handling
- Emits `ready`, `transcript`, `diagnostics`, `runtime_status`, and `error` events
- Operates in English-session mode for interview use

### 3. Inference and translation providers

- `InferenceProvider` is the canonical answer-generation interface
- `OllamaInferenceProvider` is the current local implementation
- `TranslationProvider` is a separate helper path
- Turkish translation is isolated from the main English answer path so helper failures do not block the answer

### 4. Interview orchestration

- `InterviewAssistOrchestrator` classifies the question
- Candidate sources and knowledge sources are ranked separately
- Personalization mode is decided before answer generation
- `AssistService` emits streamed partial text and structured final output

### 5. Renderer

- Control window focuses on session state, persona sources, live answer quality, and transcript review
- Overlay window shows the latest question, main English answer, and optional Turkish helper line
- Renderer captures system audio and microphone audio and forwards PCM chunks to main

## Data flow

1. Renderer captures two channels:
   - `remote`: interviewer/system audio
   - `self`: candidate microphone
2. Main forwards audio chunks to the STT worker.
3. The STT worker emits transcript events.
4. Final `remote` transcript segments are treated as interview questions.
5. `InterviewAssistOrchestrator` assembles ranked context from profile, GitHub, notes, job description, and knowledge sources.
6. `AssistService` calls the active `InferenceProvider`.
7. The provider returns a structured answer contract:
   - `answerEn`
   - `confidence`
   - `riskFlags`
8. If enabled, `TranslationProvider` creates:
   - `questionTr`
   - `helperAnswerTr`
9. Renderer updates both windows with answer, latency, and risk metadata.
10. Main stores transcript and assist events in session history for export and future dataset growth.

## Session data model

Each session snapshot keeps:

- transcript events
- assist events
- active STT model
- active inference profile
- active inference model

Assist events carry:

- `sourceText`
- `questionTr?`
- `answerEn?`
- `helperAnswerTr?`
- `supportSignals`
- `contextLinesUsed`
- `firstTokenMs`
- `qualityFlags`

## Benchmarking model

- Benchmark runner evaluates fixed clip and prompt sets
- Decisions use warm runs, not cold boot
- Primary matrix compares:
  - `llama3.1:8b-instruct-q4_K_M`
  - `qwen2.5:7b-instruct-q4_K_M`
  - `mistral:7b-instruct-v0.3-q4_K_M`
- STT sweep compares `medium.en` and `large-v3-turbo`

## Packaging notes

- Production packaging uses `electron-builder`
- Windows NSIS x64 remains the primary installer target
- `scripts/stt_worker.py` ships as an external runtime resource

## Privacy model

- Local-first by default
- No cloud dependency is required for V1
- Provider abstraction allows future SaaS endpoints without changing renderer contracts
- Settings and session history stay local unless the user explicitly exports them
