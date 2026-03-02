# IPC/API Spec (V1)

## IPC Invokes

### `settings:get`
Returns `AppSettings`.

### `settings:update`
Input: `Partial<AppSettings>`
Output: `AppSettings`

### `audio:sources`
Output: `Array<{id: string; name: string}>`

### `session:start`
Input: `{ mode: "meeting"; sttModel?: string }`
Output: `{ success: boolean }`

### `session:stop`
Output: `{ success: boolean }`

### `transcript:inject`
Input: `{ speaker: "remote" | "self"; textEn: string }`
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
- `textEn`
- `isFinal`
- `tStartMs`
- `tEndMs`
- `confidence`

### `assist:update`
Payload:
- `id`
- `transcriptId`
- `state`: `partial | final | error`
- `rawText?`
- `translationTr?`
- `replyEn?`
- `replyTr?`
- `confidence?`
- `latencyMs`
- `error?`

### `session:state`
Payload:
- `active: boolean`
- `muted: boolean`

### `shortcut:request-mute-toggle`
No payload. Renderer should invoke `assistant:toggle-mute`.

### `shortcut:mute-toggle`
Payload: `boolean` muted state.
