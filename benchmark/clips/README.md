# Benchmark Clips

Add your fixed audio clips to this directory and list them in `manifest.json`.

Recommended protocol:

1. Keep 20 clips stable across runs.
2. Use WAV mono 16kHz when possible.
3. Do not edit or reorder clips once baseline is established.

Example clip entry:

```json
{
  "id": "meeting_01",
  "audio_path": "meeting_01.wav",
  "reference_text": "Optional fallback text if STT returns empty.",
  "context_lines": ["[remote] Previous question line", "[self] Previous answer line"]
}
```
