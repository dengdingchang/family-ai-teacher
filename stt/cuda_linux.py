"""Linux CUDA admission for the isolated faster-whisper worker."""
import ctypes
import subprocess


class CudaRuntimeError(RuntimeError):
    reason = "cuda_dependencies_invalid"


class LinuxCudaRuntime:
    def __init__(self):
        self.handles = []

    def verify(self, *, complete=True):
        import ctranslate2
        if ctranslate2.get_cuda_device_count() < 1:
            raise CudaRuntimeError("No CUDA device")
        if "int8_float16" not in ctranslate2.get_supported_compute_types("cuda", 0):
            raise CudaRuntimeError("CUDA compute type unavailable")


def prepare_cuda(component_directory=None):
    runtime = LinuxCudaRuntime()
    try:
        free = int(subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits", "-i", "0"],
            timeout=3, text=True, stderr=subprocess.DEVNULL).strip())
        if free < 3072:
            error = CudaRuntimeError("Insufficient VRAM")
            error.reason = "insufficient_vram"
            raise error
        for name in ("libcublas.so.12", "libcudnn.so.9"):
            runtime.handles.append(ctypes.CDLL(name, mode=ctypes.RTLD_GLOBAL))
        runtime.verify()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise CudaRuntimeError("Linux CUDA dependencies unavailable") from exc
    return runtime
