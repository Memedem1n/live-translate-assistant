# IPC/API Spec (V1.5)

## IPC Invokes

### `settings:get`

Returns `AppSettings`.

Notable fields:

- `sttRuntimeMode: "auto" | "cuda" | "cpu"`

### `settings:update`

Input: `Partial<AppSettings>`
Output: `AppSettings`

### `audio:sources`

Output: `Array<{id: string; name: string}>`

### `history:list`

Output:

- `encryptionAvailable: boolean`
- `sessions: Array<{ id, startedAtMs, endedAtMs, persistedAtMs, transcriptCount, assistCount }>`

### `history:export`

Input:

- `format: "json" | "markdown"`
- `sessionId?`: string (optional; when omitted, exports active or last session snapshot)
  Output:
- `success: boolean`
- `format: "json" | "markdown"`
- `path: string`
- `sessionId: string`

### `session:start`

Input: `{ mode: "meeting"; sttModel?: string; sttRuntimeMode?: "auto" | "cuda" | "cpu"; sttLanguageMode?: "segment_auto" | "session_lock" | "manual"; manualSttLanguage?: "tr" | "en"; vad?: VadConfig }`
Output: `{ success: boolean }`

### `session:stop`

Output: `{ success: boolean }`

### `session:update-vad`

Input: `{ vad: VadConfig; applyMode?: "live" | "restart" }`
Output: `{ success: boolean; applied: boolean; requiresRestart: boolean }`

### `transcript:inject`

Input: `{ speaker: "remote" | "self"; text: string; language?: string }`
Output: `{ success: boolean }`

### `overlay:set`

Input: `{ visible?: boolean; opacity?: number; clickThrough?: boolean }`
Output: `{ success: boolean }`

### `assistant:toggle-mute`

Output: `{ success: boolean; muted: boolean }`

## IPC Fire-and-Forget

### `audio:chunk`

Input:

- `speaker`: `"remote" | "self"`
- `pcmBase64`: base64 PCM16LE mono
- `sampleRate`: integer (16000 default)

## IPC Events

### `transcript:final`

Payload:

- `id`
- `speaker`
- `text`
- `textEn` (legacy alias)
- `language`
- `languageConfidence?`
- `isFinal`
- `tStartMs`
- `tEndMs`
- `emittedMs`
- `confidence`

### `assist:update`

Payload:

- `id`
- `transcriptId`
- `sourceLanguage?`
- `sourceText?`
- `outputPolicy?`: `source_based | bilingual`
- `state`: `partial | final | error`
- `rawText?`
- `translationTr?`
- `replyEn?`
- `replyTr?`
- `confidence?`
- `latencyMs`
- `firstTokenMs?`
- `fallbackUsed?`
- `parseMode?`: `primary | fallback`
- `error?`

### `session:state`

Payload:

- `active: boolean`
- `muted: boolean`
- `phase: "idle" | "starting" | "running" | "degraded" | "stopping" | "error"`
- `workerReady: boolean`
- `reason?: string`
- `lastError?: string`

### `overlay:state`

Payload:

- `visible: boolean`
- `opacity: number`
- `clickThrough: boolean`

### `diagnostics:update`

Payload:

- `tsMs: number`
- `remoteRms: number`
- `selfRms: number`
- `droppedRemote: number`
- `droppedSelf: number`

### `metrics:latency`

Payload:

- `sttFirstChunkMs`: `{ latest, p50, p95, count }`
- `assistFirstTokenMs`: `{ latest, p50, p95, count }`
- `assistFinalMs`: `{ latest, p50, p95, count }`
- `workerErrorRate: number`
- `updatedAtMs: number`

### `stt:runtime-status`

Payload:

- `phase: "idle" | "loading" | "warming" | "running" | "degraded" | "error"`
- `requestedMode: "auto" | "cuda" | "cpu"`
- `activeDevice: "cuda" | "cpu" | null`
- `computeType: string | null`
- `cudaDetected: boolean`
- `cudaDeviceCount: number`
- `cudaRetryCount: number`
- `fallbackToCpuCount: number`
- `warmupMs: number | null`
- `lastError?: string`
- `model?: string`
- `updatedAtMs: number`

### `shortcut:mute-toggle`

Payload: `boolean` muted state.
