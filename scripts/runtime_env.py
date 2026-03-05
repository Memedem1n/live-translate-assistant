#!/usr/bin/env python3
"""
Shared CUDA/runtime discovery helpers for Interview Copilot Python scripts.
"""

from __future__ import annotations

import ctypes.util
import os
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]

CUDA_ERROR_MARKERS = (
    "cuda",
    "cublas",
    "cudnn",
    "cudart",
    "requested device",
    "device not found",
    "cupti",
    "driver version",
    "device-side assert",
    "cannot be loaded",
    "not found",
)

CUDNN_DLL_CANDIDATES = (
    "cudnn64_9.dll",
    "cudnn_ops64_9.dll",
    "cudnn_cnn64_9.dll",
)


def _path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def _dedupe_paths(paths: Iterable[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for raw in paths:
        if not raw:
            continue
        normalized = raw.strip()
        if not normalized:
            continue
        key = _path_key(normalized)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(normalized)
    return ordered


def _existing_dirs(paths: Iterable[Path]) -> List[str]:
    return [str(path) for path in paths if path.is_dir()]


def _collect_cuda_toolkit_dirs() -> List[Path]:
    entries: List[Path] = []
    toolkit_root = Path(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA")
    if not toolkit_root.is_dir():
        return entries

    versions = sorted(
        [item for item in toolkit_root.iterdir() if item.is_dir()],
        key=lambda item: item.name,
        reverse=True,
    )
    for version in versions:
        entries.append(version / "bin")
        entries.append(version / "bin" / "x64")

    return entries


def _collect_venv_nvidia_dirs(project_root: Optional[Path]) -> List[Path]:
    entries: List[Path] = []

    candidates: List[Path] = []
    if project_root:
        candidates.append(project_root / ".venv311" / "Lib" / "site-packages" / "nvidia")

    python_root = Path(sys.executable).resolve().parents[1]
    candidates.append(python_root / "Lib" / "site-packages" / "nvidia")

    for nvidia_root in candidates:
        if not nvidia_root.is_dir():
            continue
        for package_dir in nvidia_root.iterdir():
            if not package_dir.is_dir():
                continue
            entries.append(package_dir / "bin")

    return entries


def gather_runtime_paths(project_root: Optional[Path] = PROJECT_ROOT) -> List[str]:
    directories: List[Path] = []
    directories.extend(_collect_cuda_toolkit_dirs())
    directories.extend(_collect_venv_nvidia_dirs(project_root))
    return _dedupe_paths(_existing_dirs(directories))


def prepend_runtime_paths(paths: Iterable[str]) -> List[str]:
    desired = _dedupe_paths(paths)
    current = [item for item in os.environ.get("PATH", "").split(os.pathsep) if item]
    merged = _dedupe_paths([*desired, *current])
    os.environ["PATH"] = os.pathsep.join(merged)
    return desired


def prepare_runtime_environment(project_root: Optional[Path] = PROJECT_ROOT) -> List[str]:
    return prepend_runtime_paths(gather_runtime_paths(project_root))


def _find_dll_in_path(dll_name: str) -> Optional[str]:
    for raw_dir in os.environ.get("PATH", "").split(os.pathsep):
        if not raw_dir:
            continue
        candidate = Path(raw_dir) / dll_name
        if candidate.is_file():
            return str(candidate)
    return None


def find_dll(dll_name: str) -> Optional[str]:
    stem = Path(dll_name).stem
    library = ctypes.util.find_library(stem)
    if library:
        return str(library)
    return _find_dll_in_path(dll_name)


def detect_cuda_runtime(project_root: Optional[Path] = PROJECT_ROOT) -> Dict[str, object]:
    prepared = prepare_runtime_environment(project_root)
    cublas_path = find_dll("cublas64_12.dll")
    cublaslt_path = find_dll("cublasLt64_12.dll")
    cudart_path = find_dll("cudart64_12.dll")
    cudnn_path = None
    for candidate in CUDNN_DLL_CANDIDATES:
        found = find_dll(candidate)
        if found:
            cudnn_path = found
            break

    device_count = 0
    ctranslate2_error: Optional[str] = None
    try:
        import ctranslate2

        device_count = int(ctranslate2.get_cuda_device_count())
    except Exception as exc:  # pragma: no cover
        ctranslate2_error = str(exc)

    cuda_available = bool(cublas_path and device_count > 0)

    return {
        "prepared_paths": prepared,
        "cublas_path": cublas_path,
        "cublaslt_path": cublaslt_path,
        "cudart_path": cudart_path,
        "cudnn_path": cudnn_path,
        "cuda_device_count": device_count,
        "ctranslate2_error": ctranslate2_error,
        "cuda_available": cuda_available,
    }


def build_whisper_attempts(
    runtime_mode: str,
    supports_cuda: bool,
    compute_type: str = "auto",
) -> List[Tuple[str, str]]:
    mode = (runtime_mode or "auto").strip().lower()
    compute = (compute_type or "auto").strip().lower()

    if mode == "cpu":
        return [("cpu", "int8" if compute == "auto" else compute)]

    attempts: List[Tuple[str, str]] = []
    if supports_cuda:
        attempts.append(("cuda", "int8_float16" if compute == "auto" else compute))

    attempts.append(("cpu", "int8"))
    return attempts


def load_whisper_model(
    model_name: str,
    runtime_mode: str = "auto",
    compute_type: str = "auto",
    project_root: Optional[Path] = PROJECT_ROOT,
):
    from faster_whisper import WhisperModel

    runtime = detect_cuda_runtime(project_root)
    attempts = build_whisper_attempts(
        runtime_mode=runtime_mode,
        supports_cuda=bool(runtime.get("cuda_available")),
        compute_type=compute_type,
    )

    errors: List[str] = []
    for device, compute in attempts:
        try:
            model = WhisperModel(model_name, device=device, compute_type=compute)
            return model, device, compute, runtime, errors
        except Exception as exc:  # pragma: no cover
            errors.append(f"{device}/{compute}: {exc}")

    raise RuntimeError("Unable to load Whisper model. " + " | ".join(errors))


def is_cuda_runtime_error(error: object) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in CUDA_ERROR_MARKERS)

