"""Resolve the bundled cdecl SDK DLL for the running Python architecture."""

import ctypes
import os
from pathlib import Path


def resolve_vendor_dll_path(root=None, bits=None):
    architecture = bits or ctypes.sizeof(ctypes.c_void_p) * 8
    if architecture not in (32, 64):
        raise ValueError('Only 32-bit and 64-bit SDK libraries are available')
    sdk_root = Path(root) if root else Path(__file__).resolve().parents[1]
    return sdk_root / f'hpkSLMdaLV_cdecl_{architecture}bit' / 'hpkSLMdaLV.dll'


def load_vendor_dll(root=None, bits=None):
    dll_path = resolve_vendor_dll_path(root=root, bits=bits)
    if not dll_path.is_file():
        raise FileNotFoundError(f'Bundled SLM SDK DLL not found: {dll_path}')
    if os.name == 'nt' and hasattr(os, 'add_dll_directory'):
        with os.add_dll_directory(str(dll_path.parent)):
            return ctypes.CDLL(str(dll_path))
    return ctypes.CDLL(str(dll_path))
