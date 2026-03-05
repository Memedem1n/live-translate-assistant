# Performance Plan

## Hardware baseline

- GPU: RTX 3060 12 GB
- RAM: 16 GB
- CPU: 6 cores

## V1 latency targets

- First useful transcript chunk: `p50 < 700 ms`
- First answer token: `p50 <= 900 ms`
- Final short answer: `p50 <= 2500 ms`

## V1 quality targets

- Personalization hit rate: `>= 80%`
- Critical hallucination rate: `< 3%`
- Human answer quality score: `>= 4/5`
- English first-person compliance: `>= 95%`
- Helper translation acceptance: `>= 80%`

## Official decision policy

- Promotion decisions use `warm_gate`, not cold start
- Each candidate gets:
  - `1` cold run
  - `1` warmup run
  - `3` measured warm runs

## Benchmark matrix

### STT x inference

- `medium.en + llama3.1:8b-instruct-q4_K_M`
- `large-v3-turbo + llama3.1:8b-instruct-q4_K_M`
- `medium.en + qwen2.5:7b-instruct-q4_K_M`
- `large-v3-turbo + qwen2.5:7b-instruct-q4_K_M`
- `medium.en + mistral:7b-instruct-v0.3-q4_K_M`
- `large-v3-turbo + mistral:7b-instruct-v0.3-q4_K_M`

## Benchmark protocol

1. Use a fixed 20-sample interview clip set.
2. Use a fixed 20-prompt manual interview question set.
3. Use a fixed 10-prompt personalization set.
4. Record `p50` and `p95` for transcript, first token, and final answer latency.
5. Score quality on:
   - correctness
   - personalization fidelity
   - naturalness
   - strategic usefulness
6. Reject any candidate that violates a hard fail rule.

## Hard fail rules

- `assist_first_token_ms p50 > 900`
- `assist_final_ms p50 > 2500`
- malformed output rate `> 2%`
- critical hallucination rate `>= 3%`
- persona contradiction rate `>= 5%`

## Metrics

- `stt_first_chunk_ms`
- `assist_first_token_ms`
- `assist_final_ms`
- `worker_error_rate`
- `answer_quality_score`
- `personalization_hit_rate`
- `translation_acceptance_score`
- `critical_hallucination_rate`

## Runner

- Benchmark command: `npm run benchmark:sweep`
- Clip manifest: `benchmark/clips/manifest.json`
- Report output: `benchmark/reports/benchmark_*.json`
- Decision fields:
  - `summary.cold_start.*`
  - `summary.warm_gate.*`

## Tuning levers

- STT model choice: `medium.en` vs `large-v3-turbo`
- silence window and VAD thresholds
- answer context budget
- quantization level
- provider prewarm timing
