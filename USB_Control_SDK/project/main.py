"""Run a vendor-SDK communication smoke test when invoked as a script.

Importing this module never loads the vendor DLL or opens hardware.
"""

from ctypes import POINTER, byref, c_char_p, c_double, c_int32, c_uint8, create_string_buffer

if __package__:
    from .sdk_loader import load_vendor_dll
else:
    from sdk_loader import load_vendor_dll

MAX_DEV = 4
SERIAL_BUFFER_SIZE = 11


def configure_sdk_functions(dll):
    """Declare the ctypes interface used by this smoke test."""
    dll.Open_Dev.argtypes = [POINTER(c_uint8), c_int32]
    dll.Open_Dev.restype = c_int32

    dll.Close_Dev.argtypes = [POINTER(c_uint8), c_int32]
    dll.Close_Dev.restype = c_int32

    dll.Check_HeadSerial.argtypes = [c_uint8, c_char_p, c_int32]
    dll.Check_HeadSerial.restype = c_int32

    dll.Check_Temp.argtypes = [c_uint8, POINTER(c_double), POINTER(c_double)]
    dll.Check_Temp.restype = c_int32


def run_smoke_test(dll=None, output=print):
    """Open the connected device, read its identity and temperatures, then close it.

    Pass a DLL-compatible test double to exercise the workflow without hardware.
    """
    if dll is None:
        dll = load_vendor_dll()
    configure_sdk_functions(dll)

    device_ids = (c_uint8 * MAX_DEV)()
    device_count = dll.Open_Dev(device_ids, MAX_DEV)
    output(f"已连接的设备数为: {device_count}")
    if device_count <= 0:
        raise RuntimeError("未检测到 LCOS-SLM 设备")

    close_count = min(device_count, MAX_DEV)
    try:
        if device_count > MAX_DEV:
            raise RuntimeError(
                f"SDK 返回了 {device_count} 台设备，超过缓冲区容量 {MAX_DEV}"
            )

        device_id = device_ids[0]
        output(f"设备通信序号: {device_id}")

        serial_buffer = create_string_buffer(SERIAL_BUFFER_SIZE)
        result = dll.Check_HeadSerial(
            device_id, serial_buffer, SERIAL_BUFFER_SIZE
        )
        if result != 1:
            raise RuntimeError("读取 Head Serial 失败")
        serial = serial_buffer.value.decode(errors="replace")
        output(f"设备头部序号: {serial}")

        head_temperature = c_double()
        board_temperature = c_double()
        result = dll.Check_Temp(
            device_id, byref(head_temperature), byref(board_temperature)
        )
        if result != 1:
            raise RuntimeError("读取温度失败")

        output(f"Head Temp: {head_temperature.value:.2f} °C")
        output(f"Board Temp: {board_temperature.value:.2f} °C")
        return {
            "device_count": device_count,
            "device_id": device_id,
            "serial": serial,
            "head_temperature": head_temperature.value,
            "board_temperature": board_temperature.value,
        }
    finally:
        dll.Close_Dev(device_ids, close_count)
        output("通信验证结束，已请求关闭设备")


def main():
    run_smoke_test()


if __name__ == "__main__":
    main()
