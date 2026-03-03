# Model Kurulum ve Demo Akisi (TR)

## 1) Runtime Kurulumu

```powershell
npm run runtime:setup
```

Bu komut:

- Ollama kurulumunu kontrol eder/kurar
- Python 3.11 kurulumunu kontrol eder/kurar
- `.venv311` sanal ortamini olusturur
- `faster-whisper` paketini yukler

## 2) LLM Modellerini Cekme

```powershell
npm run models:pull
```

Varsayilan `full` profil:

- `qwen2.5:3b-instruct-q4_K_M`
- `qwen2.5:7b-instruct-q4_K_M`
- `qwen2.5:14b-instruct-q4_K_M`

## 3) Ornek Clip + STT Prewarm + Sweep

Adim adim:

```powershell
npm run clips:prepare
npm run stt:prewarm
npm run benchmark:sweep
```

Tek komut pipeline:

```powershell
npm run demo:pipeline
```

## 4) Gecikme Hedefleri (Anlik Mod)

- `stt_first_chunk_ms` p50 <= `800ms`
- `assist_first_token_ms` p50 <= `900ms`
- `assist_final_ms` p50 <= `2500ms`

## 5) Raporlar

Tum benchmark raporlari:

- `benchmark/reports/benchmark_*.json`
- `benchmark/reports/sweep_*.json`
