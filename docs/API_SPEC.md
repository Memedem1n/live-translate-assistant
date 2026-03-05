# IPC/API Spec

## Product assumptions

- Primary mode: live technical interview support
- Canonical answer language: English
- Turkish is an optional helper translation layer
- Provider configuration is runtime-pluggable

## IPC Invokes

### `settings:get`

Returns `AppSettings`.

Important fields:

- `productMode: "interview_live" | "interview_practice"`
- `sessionLanguage: "en"`
- `inferenceProfileId: "llama3_1_8b_primary" | "qwen2_5_7b_latency" | "mistral_7b_natural"`
- `helperTranslationEnabled: boolean`
- `providerConfig: { inference, translation }`

### `settings:update`

Input: `Partial<AppSettings>`  
Output: `AppSettings`

### `audio:sources`

Output: `Array<{ id: string; name: string }>`

### `history:list`

Output:

- `encryptionAvailable: boolean`
- `sessions: Array<{ id, startedAtMs, endedAtMs, persistedAtMs, transcriptCount, assistCount }>`

### `history:export`

Input:

- `format: "json" | "markdown"`
- `sessionId?`: string

Output:

- `success: boolean`
- `format: "json" | "markdown"`
- `path: string`
- `sessionId: string`

### `session:start`

Input:

```ts
{
  mode: "interview_live" | "interview_practice"
  sttModel?: string
  sttRuntimeMode?: "auto" | "cuda" | "cpu"
  vad?: VadConfig
}
```

Output: `{ success: boolean }`

### `session:stop`

Output: `{ success: boolean }`

### `session:update-vad`

Input: `{ vad: VadConfig; applyMode?: "live" | "restart" }`  
Output: `{ success: boolean; applied: boolean; requiresRestart: boolean }`

### `transcript:inject`

Input: `{ speaker: "remote" | "self"; text: string; language?: string }`  
Output: `{ success: boolean }`

### `assist:practice-generate`

Input:

```ts
{
  text: string
  language?: string
}
```

Output:

```ts
{
  success: boolean
  assist?: AssistEvent
  error?: string
}
```

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
- `sampleRate`: integer

## IPC Events

### `transcript:final`

Payload:

- `id`
- `speaker`
- `text`
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
- `questionTr?`
- `answerEn?`
- `helperAnswerTr?`
- `confidence?`
- `qualityFlags?`
- `supportSignals?`
- `contextLinesUsed?`
- `latencyMs`
- `firstTokenMs?`
- `fallbackUsed?`
- `parseMode?`: `primary | fallback`
- `personalizationMode?`
- `intentClass?`
- `answerMode?`
- `state`: `partial | final | error`
- `rawText?`
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

Payload: `boolean`
