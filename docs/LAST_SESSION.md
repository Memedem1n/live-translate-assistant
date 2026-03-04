# Last Session - 2026-03-04

## Completed Today

- Stabilized STT runtime lifecycle and diagnostics flow:
  - runtime mode: `auto | cuda | cpu`
  - eager worker warmup before ready
  - cuda retry + automatic cpu fallback
  - renderer runtime status visibility
- Extended control and overlay behavior for more reliable live usage:
  - runtime/degraded state signals in UI
  - manual assist generation path
  - transcript/assist flow improvements in interview mode
- Added personalization infrastructure:
  - profile source ingestion (`cv`, `github`, `linkedin`, `job_desc`, `note`, `knowledge_base`, `web_corpus`, `glossary`)
  - context preview + reindex path
  - profile memory orchestration and tests
- Added corpus/glossary/finetune preparation scripts:
  - `scripts/sync_web_corpus.py`
  - `scripts/build_glossary_lexicon.py`
  - `scripts/build_finetune_dataset.py`
  - `scripts/train_lora_interview.py`
  - `scripts/check_train_env.py`
  - `scripts/package_lora_for_ollama.py`
- Added train environment split to avoid runtime/train dependency conflicts:
  - `scripts/setup_train_env.ps1`
  - `scripts/run_train_python.ps1`
  - new npm scripts under `finetune:*`
- Improved dataset builder constraints:
  - source-mix enforcement toggle (`--enforce-source-mix`, `--no-enforce-source-mix`)
  - glossary ratio balancing and overflow trimming
- Disk cleanup performed:
  - removed build/artifact leftovers
  - removed unused local models (`qwen2.5:3b`, `qwen2.5:7b`)
  - kept active set: `qwen2.5:14b` + `large-v3`

## Validation Status

- `npm run typecheck` passed
- `npm run test` passed
- smoke corpus/glossary/dataset flow passed
- `finetune:prepare-lora` template generation works and blocks correctly when dataset is below threshold
- `finetune:check-env` currently reports missing train dependencies in `.venvtrain311` (expected until full train env bootstrap is run)

## Current Footprint

- project dir: ~2.86 GB
- ollama models: ~8.37 GB
- huggingface cache: ~2.90 GB
- active model/cache set significantly reduced for day-end stability

## Next Session Priority

1. Bootstrap train environment completely:
   - `npm run finetune:setup-env`
   - `npm run finetune:check-env` should return `ok=true`
2. Run LoRA smoke attempts:
   - `npm run finetune:prepare-lora:smoke`
   - inspect `artifacts/finetune/training_attempts.json`
3. If smoke succeeds, move to full training gate with selected profile sequence.
4. After training path is stable, run D-disk migration phase (project + model/cache path strategy).
