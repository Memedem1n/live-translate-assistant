#!/usr/bin/env python3
"""
NDJSON-driven local STT worker for LiveTranslate Assistant.

Commands:
- {"type":"start_session","model":"small.en","vad":{...}}
- {"type":"update_vad","vad":{...}}
- {"type":"audio_chunk","speaker":"remote|self","pcm_base64":"...","sample_rate":16000}
- {"type":"inject_transcript","speaker":"remote|self","text":"..."}
- {"type":"stop_session"}

Events:
- {"type":"ready","model":"small.en"}
- {"type":"transcript","speaker":"remote|self","text":"...","confidence":0.0}
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
import wave
from collections import defaultdict
from typing import Dict, Optional

MIN_AUDIO_MS = 450
SILENCE_MS = 320
VOICE_RMS_THRESHOLD = 380.0
CHECK_INTERVAL_SEC = 0.08
DEFAULT_SAMPLE_RATE = 16000
DIAGNOSTIC_INTERVAL_MS = 250

worker_lock = threading.Lock()

model = None
model_name = None
active = False

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


def ensure_model(target_model: str):
    global model, model_name

    if model is not None and model_name == target_model:
        return

    try:
        from faster_whisper import WhisperModel
    except Exception:
        raise RuntimeError(
            "faster-whisper is not installed. Run: pip install faster-whisper"
        )

    errors = []

    for device, compute in (("cuda", "int8_float16"), ("cpu", "int8")):
        try:
            model = WhisperModel(target_model, device=device, compute_type=compute)
            model_name = target_model
            return
        except Exception as exc:  # pragma: no cover
            errors.append(f"{device}/{compute}: {exc}")

    raise RuntimeError("Unable to load Whisper model. " + " | ".join(errors))


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


def transcribe_chunk(
    speaker: str, pcm_bytes: bytes, sample_rate: int, t_start_ms: float, t_end_ms: float
) -> None:
    if model is None:
        return

    fd, wav_path = tempfile.mkstemp(prefix="livetranslate_", suffix=".wav")
    os.close(fd)

    try:
        write_wav(wav_path, pcm_bytes, sample_rate)

        segments, _info = model.transcribe(
            wav_path,
            language="en",
            beam_size=1,
            best_of=1,
            temperature=0.0,
            vad_filter=True,
            condition_on_previous_text=False,
        )

        text_parts = []
        for segment in segments:
            seg = (segment.text or "").strip()
            if seg:
                text_parts.append(seg)

        text = " ".join(text_parts).strip()
        if text:
            emitted_ms = time.time() * 1000
            emit(
                {
                    "type": "transcript",
                    "speaker": speaker,
                    "text": text,
                    "confidence": 0.85,
                    "t_start_ms": int(t_start_ms),
                    "t_end_ms": int(t_end_ms),
                    "emitted_ms": int(emitted_ms),
                }
            )
    except Exception as exc:
        emit_error(f"STT transcription failed: {exc}")
    finally:
        if os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except OSError:
                pass


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

    target_model = str(cmd.get("model") or "small.en")

    ensure_model(target_model)
    apply_vad_config(cmd.get("vad"))

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
    emit({"type": "ready", "model": target_model})


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
            dropped_chunks[speaker] = dropped_chunks.get(speaker, 0) + 1

    maybe_emit_diagnostics()


def handle_inject_transcript(cmd: dict) -> None:
    speaker = str(cmd.get("speaker") or "remote")
    if speaker not in ("remote", "self"):
        speaker = "remote"

    text = str(cmd.get("text") or "").strip()
    if not text:
        return

    now_ms = int(time.time() * 1000)
    emit(
        {
            "type": "transcript",
            "speaker": speaker,
            "text": text,
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


# ---------- Main ----------
def main() -> None:
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


if __name__ == "__main__":
    main()
