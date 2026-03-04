# Performance Plan

## Target Hardware Baseline

- GPU: RTX 3060 12GB
- RAM: 16GB
- CPU: 6 cores

## V1 SLOs

- First meaningful transcript chunk: < 700ms (p50)
- First assist token: < 1s (p50)
- Short assist ready (2-4 sentences): < 3s (p50)

## Demo Gate (Anlik Mod)

- `stt_first_chunk_ms` p50 <= 800ms
- `assist_first_token_ms` p50 <= 900ms
- `assist_final_ms` p50 <= 2500ms
- Primary decision priority: keep first token under 1 second while preserving response quality.

## Gate Measurement Policy

- Official pass/fail decision uses `warm_gate` metrics (post-warmup runs).
- `cold_start` metrics are tracked separately as startup-risk telemetry.
- Default benchmark policy:
  - `warmup_runs = 1`
  - `runs >= 3` per combo for stable p50/p95.

## Quality Targets

- Translation adequacy for technical content: >= 80%
- Reply relevance and consistency: >= 80%

## Metrics

- `stt_first_chunk_ms`
- `assist_first_token_ms`
- `assist_final_ms`
- `translation_acceptance_score`
- `reply_relevance_score`
- `worker_error_rate`

## Benchmark Protocol

1. Use fixed 20-sample meeting clip set.
2. Run three times per build.
3. Record p50/p95 for timing metrics.
4. Manually score translation/reply on a 1-5 rubric.
5. Convert rubric to percentage; pass threshold >= 80%.

## Runner

- Benchmark command: `npm run benchmark`
- Clip manifest: `benchmark/clips/manifest.json`
- Report output: `benchmark/reports/benchmark_*.json`
- Warm/cold separation:
  - `summary.cold_start.*`
  - `summary.warm_gate.*`

## Agreed Sweep Matrix

- STT sweep with fixed assist model:
  - `small.en + qwen2.5:7b-instruct-q4_K_M`
  - `medium.en + qwen2.5:7b-instruct-q4_K_M`
  - `large-v3 + qwen2.5:7b-instruct-q4_K_M`
- Assist sweep with fixed STT model:
  - `small.en + qwen2.5:3b-instruct-q4_K_M`
  - `small.en + qwen2.5:14b-instruct-q4_K_M`
- Command:
  - `npm run benchmark:sweep`

## Immediate Tuning Knobs

- STT model (`small.en` vs `medium.en`)
- Worker silence window (`SILENCE_MS`)
- Audio worklet buffer size (renderer)
- Ollama model quantization level and context window
