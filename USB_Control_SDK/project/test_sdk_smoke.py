import ctypes
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


PROJECT_DIR = Path(__file__).resolve().parent


class FakeFunction:
    def __init__(self, callback):
        self.callback = callback
        self.argtypes = None
        self.restype = None

    def __call__(self, *args):
        return self.callback(*args)


class FakeSdkDll:
    def __init__(self, device_count=1, serial_result=1, temperature_result=1):
        self.device_count = device_count
        self.serial_result = serial_result
        self.temperature_result = temperature_result
        self.calls = []
        self.Open_Dev = FakeFunction(self.open_device)
        self.Close_Dev = FakeFunction(self.close_device)
        self.Check_HeadSerial = FakeFunction(self.read_serial)
        self.Check_Temp = FakeFunction(self.read_temperatures)

    def open_device(self, device_ids, capacity):
        self.calls.append(("open", capacity))
        if self.device_count > 0:
            device_ids[0] = 7
        return self.device_count

    def close_device(self, device_ids, count):
        self.calls.append(("close", count, list(device_ids[:count])))
        return 1

    def read_serial(self, device_id, buffer, buffer_size):
        self.calls.append(("serial", device_id, buffer_size))
        if self.serial_result == 1:
            ctypes.memmove(buffer, b"FAKE-SERIAL", min(buffer_size, 11))
        return self.serial_result

    def read_temperatures(self, device_id, head_pointer, board_pointer):
        self.calls.append(("temperatures", device_id))
        if self.temperature_result == 1:
            ctypes.cast(head_pointer, ctypes.POINTER(ctypes.c_double))[0] = 24.5
            ctypes.cast(board_pointer, ctypes.POINTER(ctypes.c_double))[0] = 31.25
        return self.temperature_result


def load_smoke_module():
    spec = importlib.util.spec_from_file_location(
        "sdk_smoke_test_subject", PROJECT_DIR / "main.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SdkSmokeTests(unittest.TestCase):
    def test_import_does_not_load_dll_or_open_hardware(self):
        with patch(
            "sdk_loader.load_vendor_dll",
            side_effect=AssertionError("DLL should only load on explicit execution"),
        ) as load_dll:
            module = load_smoke_module()

        load_dll.assert_not_called()
        self.assertTrue(callable(module.run_smoke_test))

    def test_success_reads_device_details_and_closes_device(self):
        module = load_smoke_module()
        dll = FakeSdkDll()
        output = []

        result = module.run_smoke_test(dll=dll, output=output.append)

        self.assertEqual(
            result,
            {
                "device_count": 1,
                "device_id": 7,
                "serial": "FAKE-SERIAL",
                "head_temperature": 24.5,
                "board_temperature": 31.25,
            },
        )
        self.assertEqual([call[0] for call in dll.calls], ["open", "serial", "temperatures", "close"])
        self.assertIn("通信验证结束，已请求关闭设备", output[-1])

    def test_serial_read_failure_still_closes_device(self):
        module = load_smoke_module()
        dll = FakeSdkDll(serial_result=0)

        with self.assertRaisesRegex(RuntimeError, "读取 Head Serial 失败"):
            module.run_smoke_test(dll=dll, output=lambda _message: None)

        self.assertEqual(dll.calls[-1][0], "close")

    def test_temperature_read_failure_still_closes_device(self):
        module = load_smoke_module()
        dll = FakeSdkDll(temperature_result=0)

        with self.assertRaisesRegex(RuntimeError, "读取温度失败"):
            module.run_smoke_test(dll=dll, output=lambda _message: None)

        self.assertEqual(dll.calls[-1][0], "close")

    def test_no_device_does_not_call_close(self):
        module = load_smoke_module()
        dll = FakeSdkDll(device_count=0)

        with self.assertRaisesRegex(RuntimeError, "未检测到 LCOS-SLM 设备"):
            module.run_smoke_test(dll=dll, output=lambda _message: None)

        self.assertEqual([call[0] for call in dll.calls], ["open"])

    def test_more_devices_than_buffer_capacity_closes_bounded_id_list(self):
        module = load_smoke_module()
        dll = FakeSdkDll(device_count=module.MAX_DEV + 2)

        with self.assertRaisesRegex(RuntimeError, "超过缓冲区容量"):
            module.run_smoke_test(dll=dll, output=lambda _message: None)

        self.assertEqual(dll.calls[-1], ("close", module.MAX_DEV, [7] + [0] * (module.MAX_DEV - 1)))


if __name__ == "__main__":
    unittest.main()
