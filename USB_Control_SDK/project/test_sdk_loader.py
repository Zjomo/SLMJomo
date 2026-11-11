import ctypes
import unittest
from pathlib import Path

from sdk_loader import resolve_vendor_dll_path


class SdkLoaderTests(unittest.TestCase):
    def test_resolves_bundled_cdecl_library_for_both_supported_architectures(self):
        sdk_root = Path(__file__).resolve().parents[1]
        for bits in (32, 64):
            with self.subTest(bits=bits):
                path = resolve_vendor_dll_path(bits=bits)
                self.assertEqual(path, sdk_root / f'hpkSLMdaLV_cdecl_{bits}bit' / 'hpkSLMdaLV.dll')
                self.assertTrue(path.is_file())

    def test_rejects_unsupported_architecture(self):
        with self.assertRaises(ValueError):
            resolve_vendor_dll_path(bits=16)


if __name__ == '__main__':
    unittest.main()
