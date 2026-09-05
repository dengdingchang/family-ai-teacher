"""Verified Windows CUDA dependencies, loaded only inside the STT subprocess."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import hashlib
import importlib
import importlib.util
import os
from pathlib import Path
import subprocess


MAIN_DLL = "cudnn64_9.dll"
COMPONENTS = (
    "cudnn_ops64_9.dll", "cudnn_adv64_9.dll", "cudnn_cnn64_9.dll",
    "cudnn_graph64_9.dll", "cudnn_heuristic64_9.dll",
    "cudnn_engines_precompiled64_9.dll", "cudnn_engines_runtime_compiled64_9.dll",
)
VERSIONLESS_COMPONENTS = {"cudnn_graph64_9.dll", "cudnn_heuristic64_9.dll"}
REVIEWED_VERSION = "9.10.2.21"


class CudaRuntimeError(RuntimeError):
    def __init__(self, reason="cuda_dependencies_invalid"):
        self.reason = reason
        super().__init__(reason)


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def file_version(path):
    api = ctypes.WinDLL("version", use_last_error=True)
    api.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    api.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    api.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    api.GetFileVersionInfoW.restype = wintypes.BOOL
    api.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    api.VerQueryValueW.restype = wintypes.BOOL
    size = api.GetFileVersionInfoSizeW(str(path), ctypes.byref(wintypes.DWORD()))
    if not size:
        return None
    data = ctypes.create_string_buffer(size)
    if not api.GetFileVersionInfoW(str(path), 0, size, data):
        return None
    pointer, length = ctypes.c_void_p(), wintypes.UINT()
    if not api.VerQueryValueW(data, "\\", ctypes.byref(pointer), ctypes.byref(length)):
        return None
    values = ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD))
    major, minor = values[2], values[3]
    return f"{major >> 16}.{major & 65535}.{minor >> 16}.{minor & 65535}"


def loaded_libraries():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.GetCurrentProcess.restype = wintypes.HANDLE
    api.K32EnumProcessModules.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.HMODULE), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    api.K32EnumProcessModules.restype = wintypes.BOOL
    api.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    api.GetModuleFileNameW.restype = wintypes.DWORD
    modules, needed = (wintypes.HMODULE * 2048)(), wintypes.DWORD()
    if (not api.K32EnumProcessModules(api.GetCurrentProcess(), modules, ctypes.sizeof(modules), ctypes.byref(needed))
            or needed.value > ctypes.sizeof(modules)):
        raise CudaRuntimeError()
    result = []
    for module in modules[:needed.value // ctypes.sizeof(wintypes.HMODULE)]:
        path = ctypes.create_unicode_buffer(32768)
        if not api.GetModuleFileNameW(module, path, len(path)):
            raise CudaRuntimeError()
        name = Path(path.value).name.lower()
        if name.startswith(("cudnn", "cublas", "cudart", "nvrtc")):
            result.append({"name": name, "path": Path(path.value).resolve(), "version": file_version(path.value)})
    return result


def require_free_memory(minimum_mib=3072):
    # One bounded admission check, never sampled on the transcription hot path.
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits", "-i", "0"],
            text=True, stderr=subprocess.DEVNULL, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        free = int(output.strip())
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise CudaRuntimeError("cuda_capacity_unavailable") from exc
    if free < minimum_mib:
        raise CudaRuntimeError("insufficient_vram")


def validate_bundle(directory, main_path):
    if (not directory.is_dir() or not main_path.is_file()
            or not (directory / MAIN_DLL).is_file()):
        raise CudaRuntimeError()
    expected_hash = file_hash(main_path)
    if file_hash(directory / MAIN_DLL) != expected_hash or file_version(main_path) != REVIEWED_VERSION:
        raise CudaRuntimeError()
    for name in COMPONENTS:
        path = directory / name
        if not path.is_file() or path.stat().st_size == 0:
            raise CudaRuntimeError()
        version = file_version(path)
        if version != REVIEWED_VERSION and not (version is None and name in VERSIONLESS_COMPONENTS):
            raise CudaRuntimeError()
    for name in ("cublas64_12.dll", "cublasLt64_12.dll"):
        if not (directory / name).is_file() or (directory / name).stat().st_size == 0:
            raise CudaRuntimeError()
    return expected_hash


class CudaRuntime:
    def __init__(self, directory, main_path, main_hash):
        self.directory, self.main_path, self.main_hash = directory, main_path, main_hash
        self.handles = []

    def verify(self, *, complete=True):
        libraries = loaded_libraries()
        cudnn = [item for item in libraries if item["name"].startswith("cudnn")]
        mains = [item for item in cudnn if item["name"] == MAIN_DLL]
        if (len(mains) != 1 or mains[0]["path"] != self.main_path
                or file_hash(mains[0]["path"]) != self.main_hash):
            raise CudaRuntimeError()
        for item in libraries:
            if item["name"] != MAIN_DLL and item["path"].parent != self.directory:
                raise CudaRuntimeError()
            if item["name"].startswith("cudnn") and item["version"] != REVIEWED_VERSION:
                if not (item["version"] is None and item["name"] in VERSIONLESS_COMPONENTS):
                    raise CudaRuntimeError()
        if complete and {item["name"] for item in cudnn} != {MAIN_DLL, *COMPONENTS}:
            raise CudaRuntimeError()


def prepare_cuda(component_directory):
    if os.name != "nt" or not component_directory or not Path(component_directory).is_absolute():
        raise CudaRuntimeError()
    directory = Path(component_directory).resolve()
    spec = importlib.util.find_spec("ctranslate2")
    if spec is None or not spec.origin:
        raise CudaRuntimeError()
    main_path = Path(spec.origin).resolve().parent / MAIN_DLL
    main_hash = validate_bundle(directory, main_path)
    require_free_memory()
    runtime = CudaRuntime(directory, main_path, main_hash)
    runtime.handles.append(os.add_dll_directory(str(directory)))
    os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")
    # The original CTranslate2 loader owns its main DLL. Do not load a second
    # main from the component directory, even when its bytes are identical.
    importlib.import_module("ctranslate2")
    runtime.verify(complete=False)
    for name in COMPONENTS:
        runtime.handles.append(ctypes.WinDLL(str(directory / name)))
    runtime.verify()
    return runtime
