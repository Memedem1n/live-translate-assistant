#!/usr/bin/env python3
"""
NDJSON-driven local STT worker for Interview Copilot.

Commands:
- {"type":"start_session","model":"medium","runtime_mode":"auto","language_mode":"segment_auto","manual_language":"tr","vad":{...}}
- {"type":"update_vad","vad":{...}}
- {"type":"audio_chunk","speaker":"remote|self","pcm_base64":"...","sample_rate":16000}
- {"type":"inject_transcript","speaker":"remote|self","text":"...","language":"tr|en"}
- {"type":"stop_session"}

Events:
- {"type":"ready","model":"medium"}
- {"type":"runtime_status", ...}
- {"type":"transcript","speaker":"remote|self","text":"...","language":"tr|en","language_probability":0.0,"confidence":0.0}
- {"type":"diagnostics","ts_ms":...,"remote_rms":...,"self_rms":...,"dropped_remote":...,"dropped_self":...}
- {"type":"error","message":"..."}
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import time
import traceback
import unicodedata
import wave
from collections import defaultdict
from typing import Dict, Optional

from runtime_env import detect_cuda_runtime, is_cuda_runtime_error, load_whisper_model

MIN_AUDIO_MS = 420
SILENCE_MS = 320
VOICE_RMS_THRESHOLD = 220.0
CHECK_INTERVAL_SEC = 0.05
DEFAULT_SAMPLE_RATE = 16000
DIAGNOSTIC_INTERVAL_MS = 250
MAX_CUDA_RETRY = 3

worker_lock = threading.Lock()

model = None
model_name: Optional[str] = None
active = False

runtime_requested_mode = "auto"
runtime_phase = "idle"
runtime_active_device: Optional[str] = None
runtime_compute_type: Optional[str] = None
runtime_cuda_detected = False
runtime_cuda_device_count = 0
runtime_cuda_retry_count = 0
runtime_fallback_to_cpu_count = 0
runtime_warmup_ms: Optional[float] = None
runtime_last_error: Optional[str] = None
runtime_degraded = False
runtime_max_cuda_retry = 1
runtime_eager_warmup = True
stt_language_mode = "segment_auto"
manual_language = "tr"
session_locked_language: Optional[str] = None

buffers: Dict[str, bytearray] = defaultdict(bytearray)
last_voice_ts: Dict[str, float] = {"remote": 0.0, "self": 0.0}
speech_start_ts: Dict[str, float] = {"remote": 0.0, "self": 0.0}
sample_rates: Dict[str, int] = {"remote": DEFAULT_SAMPLE_RATE, "self": DEFAULT_SAMPLE_RATE}

vad_config: Dict[str, Dict[str, float]] = {
    "remote": {
        "min_audio_ms": float(MIN_AUDIO_MS),
        "silence_ms": float(SILENCE_MS),
        "voice_rms_threshold": float(VOICE_RMS_THRESHOLD),
    },
    "self": {
        "min_audio_ms": float(MIN_AUDIO_MS),
        "silence_ms": float(SILENCE_MS),
        "voice_rms_threshold": float(VOICE_RMS_THRESHOLD),
    },
}

last_levels: Dict[str, float] = {"remote": 0.0, "self": 0.0}
dropped_chunks: Dict[str, int] = {"remote": 0, "self": 0}
last_diag_emit_ms = 0.0


# ---------- Helpers ----------
def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def emit_error(message: str) -> None:
    emit({"type": "error", "message": message})


def emit_runtime_status() -> None:
    emit(
        {
            "type": "runtime_status",
            "phase": runtime_phase,
            "requested_mode": runtime_requested_mode,
            "active_device": runtime_active_device,
            "compute_type": runtime_compute_type,
            "cuda_detected": runtime_cuda_detected,
            "cuda_device_count": runtime_cuda_device_count,
            "cuda_retry_count": runtime_cuda_retry_count,
            "fallback_to_cpu_count": runtime_fallback_to_cpu_count,
            "warmup_ms": round(runtime_warmup_ms, 2) if runtime_warmup_ms is not None else None,
            "last_error": runtime_last_error,
            "model": model_name,
            "updated_at_ms": int(time.time() * 1000),
        }
    )


def rms_int16le(raw: bytes) -> float:
    if not raw:
        return 0.0

    count = len(raw) // 2
    if count == 0:
        return 0.0

    total = 0.0
    for i in range(0, len(raw) - 1, 2):
        sample = int.from_bytes(raw[i : i + 2], byteorder="little", signed=True)
        total += sample * sample

    return (total / count) ** 0.5


def write_wav(path: str, pcm_bytes: bytes, sample_rate: int) -> None:
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)


def set_runtime_phase(phase: str, *, last_error: Optional[str] = None, degraded: Optional[bool] = None) -> None:
    global runtime_phase, runtime_last_error, runtime_degraded
    runtime_phase = phase
    runtime_last_error = last_error
    if degraded is not None:
        runtime_degraded = degraded
    emit_runtime_status()


def ensure_model(target_model: str, runtime_mode: str, force_reload: bool = False) -> None:
    global model, model_name
    global runtime_active_device, runtime_compute_type
    global runtime_cuda_detected, runtime_cuda_device_count, runtime_last_error, runtime_degraded
    global runtime_cuda_retry_count, runtime_fallback_to_cpu_count

    requested = (runtime_mode or "auto").strip().lower()
    if requested not in ("auto", "cuda", "cpu"):
        requested = "auto"

    if (
        not force_reload
        and model is not None
        and model_name == target_model
        and runtime_active_device is not None
    ):
        if requested == "auto":
            return
        if requested == runtime_active_device:
            return

    set_runtime_phase("loading")

    runtime_info = detect_cuda_runtime()
    runtime_cuda_detected = bool(runtime_info.get("cublas_path"))
    runtime_cuda_device_count = int(runtime_info.get("cuda_device_count") or 0)

    try:
        loaded_model, selected_device, selected_compute, _runtime, errors = load_whisper_model(
            model_name=target_model,
            runtime_mode=requested,
            compute_type="auto",
        )
    except Exception as exc:
        # Hard-fallback path for unstable CUDA environments (e.g. requested device not found).
        if requested == "cuda" and is_cuda_runtime_error(exc):
            runtime_degraded = True
            runtime_last_error = f"CUDA load failed, forcing CPU fallback: {exc}"
            emit_runtime_status()
            loaded_model, selected_device, selected_compute, _runtime, errors = load_whisper_model(
                model_name=target_model,
                runtime_mode="cpu",
                compute_type="auto",
            )
            runtime_fallback_to_cpu_count += 1
        else:
            raise

    if requested == "cuda" and selected_device != "cuda":
        retries = max(0, min(runtime_max_cuda_retry, MAX_CUDA_RETRY))
        for attempt in range(retries):
            runtime_cuda_retry_count += 1
            runtime_last_error = f"CUDA startup retry {attempt + 1}/{retries}: selected {selected_device}"
            emit_runtime_status()
            time.sleep(0.35)
            try:
                retry_model, retry_device, retry_compute, _runtime, retry_errors = load_whisper_model(
                    model_name=target_model,
                    runtime_mode="cuda",
                    compute_type="auto",
                )
                loaded_model = retry_model
                selected_device = retry_device
                selected_compute = retry_compute
                errors = retry_errors
                if retry_device == "cuda":
                    break
            except Exception as retry_exc:
                if not is_cuda_runtime_error(retry_exc):
                    raise
                runtime_last_error = f"CUDA startup retry failed: {retry_exc}"
                emit_runtime_status()

        if selected_device != "cuda":
            runtime_fallback_to_cpu_count += 1

    model = loaded_model
    model_name = target_model
    runtime_active_device = selected_device
    runtime_compute_type = selected_compute
    runtime_last_error = None

    if requested == "cuda" and selected_device != "cuda":
        runtime_degraded = True
        runtime_last_error = "Requested CUDA but worker started on CPU fallback."
        set_runtime_phase("degraded", last_error=runtime_last_error, degraded=True)
    else:
        runtime_degraded = runtime_degraded and selected_device == "cpu"
        next_phase = "degraded" if runtime_degraded else "running"
        set_runtime_phase(next_phase, degraded=runtime_degraded)

    if errors:
        # Keep this detail for diagnostics when fallback happened.
        runtime_last_error = " | ".join(errors)
        emit_runtime_status()


def parse_channel_vad(value: dict, fallback: Dict[str, float]) -> Dict[str, float]:
    if not isinstance(value, dict):
        return {
            "min_audio_ms": fallback["min_audio_ms"],
            "silence_ms": fallback["silence_ms"],
            "voice_rms_threshold": fallback["voice_rms_threshold"],
        }

    def num(key: str, default: float, low: float, high: float) -> float:
        raw = value.get(key, default)
        try:
            val = float(raw)
        except (TypeError, ValueError):
            val = default
        return max(low, min(high, val))

    return {
        "min_audio_ms": num("minAudioMs", fallback["min_audio_ms"], 120.0, 3000.0),
        "silence_ms": num("silenceMs", fallback["silence_ms"], 80.0, 2500.0),
        "voice_rms_threshold": num(
            "voiceRmsThreshold", fallback["voice_rms_threshold"], 50.0, 3000.0
        ),
    }


def apply_vad_config(vad_payload: Optional[dict]) -> None:
    global vad_config

    if not isinstance(vad_payload, dict):
        return

    remote = parse_channel_vad(vad_payload.get("remote"), vad_config["remote"])
    self_cfg = parse_channel_vad(vad_payload.get("self"), vad_config["self"])

    vad_config = {
        "remote": remote,
        "self": self_cfg,
    }


def maybe_emit_diagnostics(now_ms: Optional[float] = None) -> None:
    global last_diag_emit_ms

    ts_ms = now_ms if now_ms is not None else time.time() * 1000
    if ts_ms - last_diag_emit_ms < DIAGNOSTIC_INTERVAL_MS:
        return

    with worker_lock:
        payload = {
            "type": "diagnostics",
            "ts_ms": int(ts_ms),
            "remote_rms": round(last_levels.get("remote", 0.0), 2),
            "self_rms": round(last_levels.get("self", 0.0), 2),
            "dropped_remote": int(dropped_chunks.get("remote", 0)),
            "dropped_self": int(dropped_chunks.get("self", 0)),
        }

    last_diag_emit_ms = ts_ms
    emit(payload)


def transcribe_pcm(
    pcm_bytes: bytes, sample_rate: int
) -> tuple[str, Optional[str], Optional[float]]:
    if model is None:
        return "", None, None

    global session_locked_language

    forced_language: Optional[str] = None
    if stt_language_mode == "manual":
        forced_language = manual_language
    elif stt_language_mode == "session_lock" and session_locked_language:
        forced_language = session_locked_language

    fd, wav_path = tempfile.mkstemp(prefix="interview_copilot_", suffix=".wav")
    os.close(fd)

    try:
        write_wav(wav_path, pcm_bytes, sample_rate)
        segments, info = model.transcribe(
            wav_path,
            language=forced_language,
            beam_size=1,
            best_of=1,
            temperature=0.0,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        info_language = getattr(info, "language", None) if info else None
        info_probability = getattr(info, "language_probability", None) if info else None

        text_parts = []
        for segment in segments:
            seg = (segment.text or "").strip()
            if seg:
                text_parts.append(seg)
        text = " ".join(text_parts).strip()
        if text:
            text = unicodedata.normalize("NFC", text)

        detected_language = forced_language or info_language
        if stt_language_mode == "session_lock" and not session_locked_language and detected_language:
            session_locked_language = str(detected_language)
        if stt_language_mode == "manual":
            detected_language = manual_language
            info_probability = 1.0

        return text, detected_language, info_probability
    finally:
        if os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except OSError:
                pass


def recover_after_cuda_failure(
    pcm_bytes: bytes, sample_rate: int, error: Exception
) -> tuple[str, Optional[str], Optional[float]]:
    global runtime_cuda_retry_count, runtime_fallback_to_cpu_count

    last_exc: Exception = error
    target = model_name or "large-v3"
    retries = max(0, min(runtime_max_cuda_retry, MAX_CUDA_RETRY))

    for attempt in range(retries):
        runtime_cuda_retry_count += 1
        set_runtime_phase(
            "degraded",
            last_error=f"CUDA transcription retry {attempt + 1}/{retries}: {last_exc}",
            degraded=True,
        )
        time.sleep(0.5)
        try:
            ensure_model(target, "cuda", force_reload=True)
            text = transcribe_pcm(pcm_bytes, sample_rate)
            if not runtime_degraded:
                set_runtime_phase("running")
            return text
        except Exception as retry_exc:  # pragma: no cover
            last_exc = retry_exc

    runtime_fallback_to_cpu_count += 1
    set_runtime_phase(
        "degraded",
        last_error=f"CUDA unavailable, switching to CPU fallback: {last_exc}",
        degraded=True,
    )
    ensure_model(target, "cpu", force_reload=True)
    return transcribe_pcm(pcm_bytes, sample_rate)


def run_warmup() -> None:
    global runtime_warmup_ms

    # 250ms silence chunk to trigger ctranslate2 kernels and DLL loading.
    sample_rate = DEFAULT_SAMPLE_RATE
    duration_ms = 250
    pcm_bytes = b"\x00\x00" * int((duration_ms / 1000.0) * sample_rate)

    started = time.perf_counter()
    try:
        _ = transcribe_pcm(pcm_bytes, sample_rate)
    except Exception as exc:
        if runtime_active_device == "cuda" and is_cuda_runtime_error(exc):
            _ = recover_after_cuda_failure(pcm_bytes, sample_rate, exc)
        else:
            raise
    runtime_warmup_ms = (time.perf_counter() - started) * 1000.0

    next_phase = "degraded" if runtime_degraded else "running"
    set_runtime_phase(next_phase, degraded=runtime_degraded)


def transcribe_chunk(
    speaker: str, pcm_bytes: bytes, sample_rate: int, t_start_ms: float, t_end_ms: float
) -> None:
    if model is None:
        return

    try:
        text, detected_language, language_probability = transcribe_pcm(pcm_bytes, sample_rate)
    except Exception as exc:
        if runtime_active_device == "cuda" and is_cuda_runtime_error(exc):
            try:
                text, detected_language, language_probability = recover_after_cuda_failure(
                    pcm_bytes, sample_rate, exc
                )
            except Exception as nested:
                emit_error(f"STT transcription failed after CUDA fallback: {nested}")
                set_runtime_phase("error", last_error=str(nested), degraded=True)
                return
        else:
            emit_error(f"STT transcription failed: {exc}")
            set_runtime_phase("error", last_error=str(exc), degraded=runtime_degraded)
            return

    if text:
        emitted_ms = time.time() * 1000
        emit(
            {
                "type": "transcript",
                "speaker": speaker,
                "text": text,
                "language": detected_language or "unknown",
                "language_probability": language_probability,
                "confidence": 0.85,
                "t_start_ms": int(t_start_ms),
                "t_end_ms": int(t_end_ms),
                "emitted_ms": int(emitted_ms),
            }
        )


# ---------- Background loop ----------
def monitor_loop() -> None:
    global active

    while True:
        time.sleep(CHECK_INTERVAL_SEC)

        if not active:
            continue

        now_ms = time.time() * 1000
        to_transcribe = []

        with worker_lock:
            for speaker in ("remote", "self"):
                rate = sample_rates.get(speaker, DEFAULT_SAMPLE_RATE)
                channel_vad = vad_config.get(speaker, vad_config["remote"])
                min_bytes = int((channel_vad["min_audio_ms"] / 1000.0) * rate * 2)
                buffer = buffers[speaker]

                if len(buffer) < min_bytes:
                    continue

                elapsed = now_ms - last_voice_ts.get(speaker, 0.0)
                if elapsed < channel_vad["silence_ms"]:
                    continue

                chunk = bytes(buffer)
                buffers[speaker] = bytearray()
                t_start = speech_start_ts.get(speaker, now_ms)
                speech_start_ts[speaker] = 0.0
                to_transcribe.append((speaker, chunk, rate, t_start, now_ms))

        for speaker, chunk, rate, t_start, t_end in to_transcribe:
            transcribe_chunk(speaker, chunk, rate, t_start, t_end)

        maybe_emit_diagnostics(now_ms)


# ---------- Command handling ----------
def handle_start_session(cmd: dict) -> None:
    global active
    global runtime_requested_mode, runtime_cuda_retry_count, runtime_fallback_to_cpu_count
    global runtime_max_cuda_retry, runtime_eager_warmup, runtime_warmup_ms, runtime_degraded
    global runtime_last_error
    global stt_language_mode, manual_language, session_locked_language

    target_model = str(cmd.get("model") or "large-v3")
    requested_mode = str(cmd.get("runtime_mode") or "auto").strip().lower()
    if requested_mode not in ("auto", "cuda", "cpu"):
        requested_mode = "auto"

    language_mode = str(cmd.get("language_mode") or "segment_auto").strip().lower()
    if language_mode not in ("segment_auto", "session_lock", "manual"):
        language_mode = "segment_auto"
    requested_manual_language = str(cmd.get("manual_language") or "tr").strip().lower()
    if requested_manual_language not in ("tr", "en"):
        requested_manual_language = "tr"
    stt_language_mode = language_mode
    manual_language = requested_manual_language
    session_locked_language = None

    runtime_requested_mode = requested_mode
    runtime_cuda_retry_count = 0
    runtime_fallback_to_cpu_count = 0
    runtime_warmup_ms = None
    runtime_degraded = False
    runtime_last_error = None

    try:
        runtime_max_cuda_retry = int(cmd.get("cuda_retry_count", 1))
    except (TypeError, ValueError):
        runtime_max_cuda_retry = 1
    runtime_max_cuda_retry = max(0, min(MAX_CUDA_RETRY, runtime_max_cuda_retry))

    eager_warmup = cmd.get("eager_warmup", True)
    runtime_eager_warmup = bool(eager_warmup)

    ensure_model(target_model, runtime_requested_mode, force_reload=False)
    apply_vad_config(cmd.get("vad"))

    if runtime_eager_warmup:
        set_runtime_phase("warming", degraded=runtime_degraded)
        run_warmup()

    with worker_lock:
        buffers["remote"] = bytearray()
        buffers["self"] = bytearray()
        dropped_chunks["remote"] = 0
        dropped_chunks["self"] = 0
        last_levels["remote"] = 0.0
        last_levels["self"] = 0.0
        now_ms = time.time() * 1000
        last_voice_ts["remote"] = now_ms
        last_voice_ts["self"] = now_ms
        speech_start_ts["remote"] = now_ms
        speech_start_ts["self"] = now_ms

    active = True
    emit(
        {
            "type": "ready",
            "model": target_model,
            "active_device": runtime_active_device,
            "compute_type": runtime_compute_type,
        }
    )
    if not runtime_eager_warmup:
        next_phase = "degraded" if runtime_degraded else "running"
        set_runtime_phase(next_phase, degraded=runtime_degraded)


def handle_update_vad(cmd: dict) -> None:
    apply_vad_config(cmd.get("vad"))


def handle_audio_chunk(cmd: dict) -> None:
    if not active:
        return

    speaker = str(cmd.get("speaker") or "remote")
    if speaker not in ("remote", "self"):
        speaker = "remote"

    b64 = cmd.get("pcm_base64")
    if not isinstance(b64, str) or not b64:
        return

    try:
        pcm = base64.b64decode(b64)
    except Exception:
        return

    sample_rate = int(cmd.get("sample_rate") or DEFAULT_SAMPLE_RATE)
    level = rms_int16le(pcm)

    with worker_lock:
        sample_rates[speaker] = sample_rate
        last_levels[speaker] = level

        threshold = vad_config.get(speaker, vad_config["remote"])["voice_rms_threshold"]
        if level >= threshold:
            if len(buffers[speaker]) == 0:
                speech_start_ts[speaker] = time.time() * 1000
            buffers[speaker].extend(pcm)
            last_voice_ts[speaker] = time.time() * 1000
        else:
            # Keep low-energy tail chunks while an utterance is active.
            # This avoids clipping end-of-sentence words.
            if len(buffers[speaker]) > 0:
                buffers[speaker].extend(pcm)
            else:
                dropped_chunks[speaker] = dropped_chunks.get(speaker, 0) + 1

    maybe_emit_diagnostics()


def handle_inject_transcript(cmd: dict) -> None:
    speaker = str(cmd.get("speaker") or "remote")
    if speaker not in ("remote", "self"):
        speaker = "remote"

    text = unicodedata.normalize("NFC", str(cmd.get("text") or "").strip())
    language = str(cmd.get("language") or "en").strip().lower()
    if language not in ("tr", "en"):
        language = "unknown"
    if not text:
        return

    now_ms = int(time.time() * 1000)
    emit(
        {
            "type": "transcript",
            "speaker": speaker,
            "text": text,
            "language": language,
            "language_probability": 1.0,
            "confidence": 0.95,
            "t_start_ms": now_ms,
            "t_end_ms": now_ms,
            "emitted_ms": now_ms,
        }
    )


def handle_stop_session() -> None:
    global active
    active = False

    with worker_lock:
        buffers["remote"] = bytearray()
        buffers["self"] = bytearray()
        speech_start_ts["remote"] = 0.0
        speech_start_ts["self"] = 0.0

    set_runtime_phase("idle", degraded=runtime_degraded)


# ---------- Main ----------
def main() -> None:
    emit_runtime_status()

    t = threading.Thread(target=monitor_loop, daemon=True)
    t.start()

    for raw in iter(input, ""):
        line = raw.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
            command_type = cmd.get("type")

            if command_type == "start_session":
                handle_start_session(cmd)
            elif command_type == "update_vad":
                handle_update_vad(cmd)
            elif command_type == "audio_chunk":
                handle_audio_chunk(cmd)
            elif command_type == "inject_transcript":
                handle_inject_transcript(cmd)
            elif command_type == "stop_session":
                handle_stop_session()
            else:
                emit_error(f"Unknown command: {command_type}")
        except Exception as exc:
            emit_error(f"Worker exception: {exc}")
            emit({"type": "error", "message": traceback.format_exc()})
            set_runtime_phase("error", last_error=str(exc), degraded=True)


if __name__ == "__main__":
    main()

