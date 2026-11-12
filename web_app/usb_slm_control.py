"""
USB_SLMControl 驱动层
=====================
还原 Hamamatsu USB_SLMControl.exe 的核心控制能力（基于 L55-0491_USB_Control_SDK 手册
与 hpkSLMdaLV.h 头文件），为 Flask UI 提供 LCOS-SLM USB 控制接口。

驱动后端:
  - LVRealDriver      : 绑定 USB_Control_SDK/hpkSLMdaLV_stdcall_64bit/hpkSLMdaLV.dll
                        （需要 64 位 LabVIEW Runtime 2015+）
  - SimulatedDriver   : 内存模拟实现（819 帧存储槽 / 5659 SD 槽 / 温度 / LED / IO / 模式），
                        无硬件环境可完整运行与测试。

SDK 常量（手册约定）:
  - 帧存储器槽位 FMem : 0 ~ 818
  - SD 卡槽位         : 0 ~ 5658
  - 图像尺寸          : SXGA 1272 x 1024 (1302528 字节, 8-bit 灰度)
  - 模式              : 0 = DVI 模式, 1 = USB/Trigger 模式
  - Check_HeadSerial  : 序列号缓冲 11 字符
"""

import os
import csv
import io
import sys
import glob
import json
import queue
import base64
import hashlib
import threading
import time
import logging
import subprocess
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# ==================== SDK 常量 ====================
X_PIXEL = 1272
Y_PIXEL = 1024
ARRAY_SIZE = X_PIXEL * Y_PIXEL  # 1302528

FMEM_SLOT_MIN, FMEM_SLOT_MAX = 0, 818
SD_SLOT_MIN, SD_SLOT_MAX = 0, 5658
MODE_DVI = 0
MODE_USB_TRIGGER = 1
HEAD_SERIAL_SIZE = 11

# 项目内 SDK DLL 路径（64 位 stdcall 包装 DLL，同目录需有 hpkSLMda.dll）
_SDK_DIR = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'USB_Control_SDK',
    'hpkSLMdaLV_stdcall_64bit'))
REAL_DLL_PATH = os.path.join(_SDK_DIR, 'hpkSLMdaLV.dll')


class SLMDriverError(Exception):
    """驱动层错误（DLL 缺失 / 硬件调用失败 / 参数非法）"""


class SLMSequenceUploadError(SLMDriverError):
    """批量写入序列失败，并携带回滚结果。"""

    def __init__(self, message, uploaded_count=0, restore_failed_slots=None):
        super().__init__(message)
        self.uploaded_count = int(uploaded_count)
        self.restore_failed_slots = list(restore_failed_slots or [])


# ==================== 公共校验工具 ====================
def validate_fmem_slot(slot: int) -> int:
    slot = int(slot)
    if not (FMEM_SLOT_MIN <= slot <= FMEM_SLOT_MAX):
        raise SLMDriverError(f'帧存储器槽位必须在 {FMEM_SLOT_MIN}~{FMEM_SLOT_MAX} 之间，收到 {slot}')
    return slot


def validate_sd_slot(slot: int) -> int:
    slot = int(slot)
    if not (SD_SLOT_MIN <= slot <= SD_SLOT_MAX):
        raise SLMDriverError(f'SD 卡槽位必须在 {SD_SLOT_MIN}~{SD_SLOT_MAX} 之间，收到 {slot}')
    return slot


def validate_mode(mode: int) -> int:
    mode = int(mode)
    if mode not in (MODE_DVI, MODE_USB_TRIGGER):
        raise SLMDriverError(f'模式只能是 0(DVI) 或 1(USB/Trigger)，收到 {mode}')
    return mode


# ==================== 驱动基类（SDK 20 函数语义） ====================
class SLMDriverBase:
    """与 hpkSLMdaLV.dll 一致的函数语义。所有函数在硬件断开时抛 SLMDriverError。"""

    name = 'base'

    def open_dev(self, probe_count: int = 8) -> List[int]:
        """Open_Dev: 与所有 USB 连接的控制器建立通信，返回 bID 列表。"""
        raise NotImplementedError

    def close_dev(self, bids: List[int]) -> None:
        """Close_Dev: 断开指定设备通信。"""
        raise NotImplementedError

    def check_head_serial(self, bid: int) -> str:
        raise NotImplementedError

    def write_fmem_array(self, bid: int, data: bytes, slot: int) -> None:
        raise NotImplementedError

    def write_fmem_bmp_path(self, bid: int, path: str, slot: int) -> None:
        raise NotImplementedError

    def change_disp_slot(self, bid: int, slot: int) -> None:
        raise NotImplementedError

    def check_temp(self, bid: int) -> Tuple[float, float]:
        """返回 (HeadTemp, CBTemp) 摄氏度。"""
        raise NotImplementedError

    def check_fmem_slot(self, bid: int, slot: int) -> bytes:
        """返回 ARRAY_SIZE 字节灰度数据。"""
        raise NotImplementedError

    def check_disp_img(self, bid: int) -> bytes:
        raise NotImplementedError

    def mode_select(self, bid: int, mode: int) -> None:
        raise NotImplementedError

    def mode_check(self, bid: int) -> int:
        raise NotImplementedError

    def check_led(self, bid: int) -> int:
        raise NotImplementedError

    def check_io(self, bid: int) -> int:
        raise NotImplementedError

    def reboot(self, bid: int) -> None:
        raise NotImplementedError

    def write_sd_bmp_path(self, bid: int, path: str, slot: int) -> None:
        raise NotImplementedError

    def write_sd_array(self, bid: int, data: bytes, slot: int) -> None:
        raise NotImplementedError

    def check_sd_slot(self, bid: int, slot: int) -> bytes:
        raise NotImplementedError

    def upload_sd_to_fmem(self, bid: int, sd_slot: int, fmem_slot: int) -> None:
        raise NotImplementedError


# ==================== 真实硬件驱动 ====================
class LVRealDriver(SLMDriverBase):
    """ctypes 绑定 hpkSLMdaLV.dll（64 位 stdcall）。"""

    name = 'real'

    def __init__(self):
        import ctypes
        self._ctypes = ctypes
        if not os.path.isfile(REAL_DLL_PATH):
            raise SLMDriverError(
                f'未找到 SDK DLL: {REAL_DLL_PATH}')
        # 先用子进程探测 DLL 可加载性（LabVIEW DLL 初始化可能长时间阻塞，
        # 直接在本进程加载存在挂死风险，探测失败立即报错回退模拟驱动）
        if not real_driver_available_cached(ttl=10.0):
            raise SLMDriverError(
                '无法加载 hpkSLMdaLV.dll（本机缺少 64 位 LabVIEW Runtime 2015+，'
                '或 DLL 初始化失败）。请安装 LabVIEW Runtime，或改用模拟模式。')
        try:
            os.add_dll_directory(_SDK_DIR)
            # WinDLL -> __stdcall 约定
            self._lib = ctypes.WinDLL(REAL_DLL_PATH)
        except OSError as exc:
            raise SLMDriverError(
                '无法加载 hpkSLMdaLV.dll（本机缺少 64 位 LabVIEW Runtime 2015+）。'
                '请安装 LabVIEW Runtime，或改用模拟模式。'
                f'系统错误: {exc}') from exc
        self._bind_prototypes()

    def _bind_prototypes(self):
        import ctypes
        c = self._ctypes
        u8p = ctypes.POINTER(c.c_uint8)
        lib = self._lib
        lib.Open_Dev.restype = c.c_int32
        lib.Open_Dev.argtypes = [u8p, c.c_int32]
        lib.Close_Dev.restype = c.c_int32
        lib.Close_Dev.argtypes = [u8p, c.c_int32]
        lib.Check_HeadSerial.restype = c.c_int32
        lib.Check_HeadSerial.argtypes = [c.c_uint8, c.c_char_p, c.c_int32]
        lib.Write_FMemArray.restype = c.c_int32
        lib.Write_FMemArray.argtypes = [c.c_uint8, u8p, c.c_int32,
                                        c.c_uint32, c.c_uint32, c.c_uint32]
        lib.Write_FMemBMPPath.restype = c.c_int32
        lib.Write_FMemBMPPath.argtypes = [c.c_uint8, c.c_char_p, c.c_uint32]
        lib.Change_DispSlot.restype = c.c_int32
        lib.Change_DispSlot.argtypes = [c.c_uint8, c.c_uint32]
        lib.Check_Temp.restype = c.c_int32
        lib.Check_Temp.argtypes = [c.c_uint8, ctypes.POINTER(c.c_double),
                                   ctypes.POINTER(c.c_double)]
        lib.Check_FMem_Slot.restype = c.c_int32
        lib.Check_FMem_Slot.argtypes = [c.c_uint8, c.c_uint32, c.c_uint32,
                                        c.c_uint32, c.c_uint32, u8p]
        lib.Mode_Select.restype = c.c_int32
        lib.Mode_Select.argtypes = [c.c_uint8, c.c_uint8]
        lib.Check_Disp_IMG.restype = c.c_int32
        lib.Check_Disp_IMG.argtypes = [c.c_uint8, c.c_uint32, c.c_uint32,
                                       c.c_uint32, u8p]
        lib.Check_LED.restype = c.c_int32
        lib.Check_LED.argtypes = [c.c_uint8, ctypes.POINTER(c.c_uint32)]
        lib.Mode_Check.restype = c.c_int32
        lib.Mode_Check.argtypes = [c.c_uint8, ctypes.POINTER(c.c_uint32)]
        lib.Check_IO.restype = c.c_int32
        lib.Check_IO.argtypes = [c.c_uint8, ctypes.POINTER(c.c_uint32)]
        lib.Reboot.restype = None
        lib.Reboot.argtypes = [c.c_uint8]
        lib.Write_SDBMPPath.restype = c.c_int32
        lib.Write_SDBMPPath.argtypes = [c.c_uint8, c.c_char_p, c.c_uint32]
        lib.Write_SDArray.restype = c.c_int32
        lib.Write_SDArray.argtypes = [c.c_uint8, u8p, c.c_int32,
                                      c.c_uint32, c.c_uint32, c.c_uint32]
        lib.Check_SD_Slot.restype = c.c_int32
        lib.Check_SD_Slot.argtypes = [c.c_uint8, c.c_uint32, c.c_uint32,
                                      c.c_uint32, c.c_uint32, u8p]
        lib.Upload_from_SD_to_FMem.restype = c.c_int32
        lib.Upload_from_SD_to_FMem.argtypes = [c.c_uint8, c.c_uint32, c.c_uint32]

    @staticmethod
    def _check(rv: int, func: str) -> None:
        if rv != 1:
            raise SLMDriverError(f'{func} 调用失败（返回值 {rv}）')

    def open_dev(self, probe_count: int = 8) -> List[int]:
        c = self._ctypes
        buf = (c.c_uint8 * max(1, probe_count))()
        n = int(self._lib.Open_Dev(buf, probe_count))
        if n < 0:
            raise SLMDriverError(f'Open_Dev 调用失败（返回值 {n}）')
        return [int(buf[i]) for i in range(min(n, probe_count))]

    def close_dev(self, bids: List[int]) -> None:
        c = self._ctypes
        n = len(bids)
        buf = (c.c_uint8 * max(1, n))(*[int(b) for b in bids]) if n else (c.c_uint8 * 1)()
        self._check(int(self._lib.Close_Dev(buf, n)), 'Close_Dev')

    def check_head_serial(self, bid: int) -> str:
        c = self._ctypes
        buf = c.create_string_buffer(HEAD_SERIAL_SIZE + 1)
        self._check(int(self._lib.Check_HeadSerial(bid, buf, HEAD_SERIAL_SIZE)),
                    'Check_HeadSerial')
        return buf.value.decode('ascii', errors='replace')

    def write_fmem_array(self, bid: int, data: bytes, slot: int) -> None:
        c = self._ctypes
        slot = validate_fmem_slot(slot)
        if len(data) != ARRAY_SIZE:
            raise SLMDriverError(f'图像数据必须为 {ARRAY_SIZE} 字节（{X_PIXEL}x{Y_PIXEL}），收到 {len(data)}')
        arr = (c.c_uint8 * ARRAY_SIZE).from_buffer_copy(data)
        self._check(int(self._lib.Write_FMemArray(bid, arr, ARRAY_SIZE,
                                                  X_PIXEL, Y_PIXEL, slot)),
                    'Write_FMemArray')

    def write_fmem_bmp_path(self, bid: int, path: str, slot: int) -> None:
        slot = validate_fmem_slot(slot)
        if not os.path.isfile(path):
            raise SLMDriverError(f'BMP 文件不存在: {path}')
        self._check(int(self._lib.Write_FMemBMPPath(bid, path.encode('mbcs'), slot)),
                    'Write_FMemBMPPath')

    def change_disp_slot(self, bid: int, slot: int) -> None:
        slot = validate_fmem_slot(slot)
        self._check(int(self._lib.Change_DispSlot(bid, slot)), 'Change_DispSlot')

    def check_temp(self, bid: int) -> Tuple[float, float]:
        c = self._ctypes
        head = c.c_double()
        cb = c.c_double()
        self._check(int(self._lib.Check_Temp(bid, c.byref(head), c.byref(cb))),
                    'Check_Temp')
        return head.value, cb.value

    def _read_image(self, lib_func, bid: int, slot: Optional[int]) -> bytes:
        c = self._ctypes
        arr = (c.c_uint8 * ARRAY_SIZE)()
        if slot is None:
            rv = lib_func(bid, ARRAY_SIZE, X_PIXEL, Y_PIXEL, arr)
        else:
            rv = lib_func(bid, ARRAY_SIZE, X_PIXEL, Y_PIXEL, slot, arr)
        self._check(int(rv), lib_func.__name__ if hasattr(lib_func, '__name__') else 'ReadImg')
        return bytes(bytearray(arr))

    def check_fmem_slot(self, bid: int, slot: int) -> bytes:
        validate_fmem_slot(slot)
        return self._read_image(self._lib.Check_FMem_Slot, bid, slot)

    def check_disp_img(self, bid: int) -> bytes:
        return self._read_image(self._lib.Check_Disp_IMG, bid, None)

    def mode_select(self, bid: int, mode: int) -> None:
        validate_mode(mode)
        self._check(int(self._lib.Mode_Select(bid, mode)), 'Mode_Select')

    def mode_check(self, bid: int) -> int:
        c = self._ctypes
        mode = c.c_uint32()
        self._check(int(self._lib.Mode_Check(bid, c.byref(mode))), 'Mode_Check')
        return int(mode.value)

    def check_led(self, bid: int) -> int:
        c = self._ctypes
        led = c.c_uint32()
        self._check(int(self._lib.Check_LED(bid, c.byref(led))), 'Check_LED')
        return int(led.value)

    def check_io(self, bid: int) -> int:
        c = self._ctypes
        io_stat = c.c_uint32()
        self._check(int(self._lib.Check_IO(bid, c.byref(io_stat))), 'Check_IO')
        return int(io_stat.value)

    def reboot(self, bid: int) -> None:
        # 手册: 重启后 USB 通信中断，需等待后重新 Open_Dev
        self._lib.Reboot(bid)

    def write_sd_bmp_path(self, bid: int, path: str, slot: int) -> None:
        validate_sd_slot(slot)
        if not os.path.isfile(path):
            raise SLMDriverError(f'BMP 文件不存在: {path}')
        self._check(int(self._lib.Write_SDBMPPath(bid, path.encode('mbcs'), slot)),
                    'Write_SDBMPPath')

    def write_sd_array(self, bid: int, data: bytes, slot: int) -> None:
        c = self._ctypes
        slot = validate_sd_slot(slot)
        if len(data) != ARRAY_SIZE:
            raise SLMDriverError(f'图像数据必须为 {ARRAY_SIZE} 字节，收到 {len(data)}')
        arr = (c.c_uint8 * ARRAY_SIZE).from_buffer_copy(data)
        self._check(int(self._lib.Write_SDArray(bid, arr, ARRAY_SIZE,
                                                X_PIXEL, Y_PIXEL, slot)),
                    'Write_SDArray')

    def check_sd_slot(self, bid: int, slot: int) -> bytes:
        validate_sd_slot(slot)
        return self._read_image(self._lib.Check_SD_Slot, bid, slot)

    def upload_sd_to_fmem(self, bid: int, sd_slot: int, fmem_slot: int) -> None:
        validate_sd_slot(sd_slot)
        validate_fmem_slot(fmem_slot)
        self._check(int(self._lib.Upload_from_SD_to_FMem(bid, sd_slot, fmem_slot)),
                    'Upload_from_SD_to_FMem')


# ==================== 模拟驱动 ====================
class SimulatedDriver(SLMDriverBase):
    """
    内存模拟 hpkSLMdaLV.dll 全部语义。
    - FMem 819 槽 / SD 5659 槽，初始全 0（黑图）
    - 模式默认 DVI(0)；USB/Trigger 模式下 LED10 点亮（bit0=1）
    - 温度: 头 30.0±1.5℃，控制板 35.0±1.0℃（缓慢漂移）
    - 重启: 断开连接（对应手册：需重新 Open_Dev）
    """

    name = 'sim'

    def __init__(self):
        self._lock = threading.Lock()
        self._serials = {i: f'X{15220 + i:05d}' for i in range(4)}
        self._fmem = {}
        self._sd = {}
        self._disp_slot = {i: 0 for i in range(4)}
        self._mode = {i: MODE_DVI for i in range(4)}
        self._opened = False
        self._t0 = time.time()

    @staticmethod
    def _require_open():
        pass

    def open_dev(self, probe_count: int = 8) -> List[int]:
        self._opened = True
        self._t0 = time.time()
        return list(range(2))  # 模拟 2 台设备

    def close_dev(self, bids: List[int]) -> None:
        self._opened = False

    def check_head_serial(self, bid: int) -> str:
        return self._serials.get(int(bid), 'X15220')

    def write_fmem_array(self, bid: int, data: bytes, slot: int) -> None:
        slot = validate_fmem_slot(slot)
        if len(data) != ARRAY_SIZE:
            raise SLMDriverError(f'图像数据必须为 {ARRAY_SIZE} 字节，收到 {len(data)}')
        self._fmem[slot] = bytes(data)

    def write_fmem_bmp_path(self, bid: int, path: str, slot: int) -> None:
        slot = validate_fmem_slot(slot)
        if not os.path.isfile(path):
            raise SLMDriverError(f'BMP 文件不存在: {path}')
        with open(path, 'rb') as fh:
            raw = fh.read()
        # 8-bit BMP 像素数据从文件头 1078 偏移开始（BITMAPINFOHEADER + 256 调色板）
        payload = raw[1078:1078 + ARRAY_SIZE]
        if len(payload) != ARRAY_SIZE:
            raise SLMDriverError('BMP 必须为 1272x1024 8-bit 格式')
        self._fmem[slot] = payload

    def change_disp_slot(self, bid: int, slot: int) -> None:
        slot = validate_fmem_slot(slot)
        self._disp_slot[int(bid)] = slot

    def check_temp(self, bid: int) -> Tuple[float, float]:
        t = time.time() - self._t0
        head = 30.0 + 1.5 * ((t % 60) / 60.0 - 0.5)
        cb = 35.0 + 1.0 * ((t % 90) / 90.0 - 0.5)
        return round(head, 2), round(cb, 2)

    def check_fmem_slot(self, bid: int, slot: int) -> bytes:
        validate_fmem_slot(slot)
        return self._fmem.get(slot, bytes(ARRAY_SIZE))

    def check_disp_img(self, bid: int) -> bytes:
        return self._fmem.get(self._disp_slot.get(int(bid), 0), bytes(ARRAY_SIZE))

    def mode_select(self, bid: int, mode: int) -> None:
        validate_mode(mode)
        self._mode[int(bid)] = mode  # 模拟立即生效（真机需重启生效）

    def mode_check(self, bid: int) -> int:
        return self._mode.get(int(bid), MODE_DVI)

    def check_led(self, bid: int) -> int:
        # USB/Trigger 模式下 LED10 亮 → bit0 = 1
        return 1 if self._mode.get(int(bid), MODE_DVI) == MODE_USB_TRIGGER else 0

    def check_io(self, bid: int) -> int:
        # bit1 对应 IO4 帧信号，随显示翻转；其余引脚保持低
        frame_bit = int(time.time() * 60) % 2
        return frame_bit << 1

    def reboot(self, bid: int) -> None:
        self._opened = False  # USB 通信中断

    def write_sd_bmp_path(self, bid: int, path: str, slot: int) -> None:
        slot = validate_sd_slot(slot)
        if not os.path.isfile(path):
            raise SLMDriverError(f'BMP 文件不存在: {path}')
        with open(path, 'rb') as fh:
            raw = fh.read()
        payload = raw[1078:1078 + ARRAY_SIZE]
        if len(payload) != ARRAY_SIZE:
            raise SLMDriverError('BMP 必须为 1272x1024 8-bit 格式')
        self._sd[slot] = payload

    def write_sd_array(self, bid: int, data: bytes, slot: int) -> None:
        slot = validate_sd_slot(slot)
        if len(data) != ARRAY_SIZE:
            raise SLMDriverError(f'图像数据必须为 {ARRAY_SIZE} 字节，收到 {len(data)}')
        self._sd[slot] = bytes(data)

    def check_sd_slot(self, bid: int, slot: int) -> bytes:
        validate_sd_slot(slot)
        return self._sd.get(slot, bytes(ARRAY_SIZE))

    def upload_sd_to_fmem(self, bid: int, sd_slot: int, fmem_slot: int) -> None:
        validate_sd_slot(sd_slot)
        validate_fmem_slot(fmem_slot)
        self._fmem[fmem_slot] = self._sd.get(sd_slot, bytes(ARRAY_SIZE))


# ==================== 32 位桥接驱动（真机 · 无需 64 位 LVRT） ====================
# 64 位 Python 进程无法直接加载 32 位 hpkSLMdaLV.dll（Windows 位数限制）。
# 方案：用系统自带的 32 位 csc.exe 编译 usb_slm_bridge32.cs 为 32 位常驻桥进程，
# 主进程通过 stdio JSON 行协议调用 18 个 SDK 函数。
_APP_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE_SOURCE_PATH = os.path.join(_APP_DIR, 'usb_slm_bridge32.cs')
BRIDGE_BUILD_DIR = os.path.join(_APP_DIR, '_build')
BRIDGE_EXE_PATH = os.path.join(BRIDGE_BUILD_DIR, 'usb_slm_bridge32.exe')

# 32 位 LabVIEW Runtime 根目录（本机 LabVIEW 2018 部署位置；可用环境变量
# USB_SLM_LVRT_DIRS 以分号分隔覆盖/追加）
EXTRA_LVRT_ROOTS = [
    r'F:\0_MyProject\LabView2018\Shared\LabVIEW Run-Time',
]
STANDARD_LVRT_ROOTS = [
    r'C:\Program Files (x86)\National Instruments\Shared\LabVIEW Run-Time',
    r'C:\Program Files\National Instruments\Shared\LabVIEW Run-Time',
]


def find_csc32() -> Optional[str]:
    """定位 .NET Framework 自带的 32 位 C# 编译器。"""
    hits = sorted(glob.glob(r'C:\Windows\Microsoft.NET\Framework\v4*\csc.exe'))
    return hits[-1] if hits else None


def find_lvrt_dirs() -> List[str]:
    """发现 32 位 LabVIEW Runtime 目录（含 lvrt.dll），版本号倒序。"""
    roots: List[str] = []
    env_dirs = os.environ.get('USB_SLM_LVRT_DIRS', '')
    if env_dirs:
        roots.extend(d for d in env_dirs.split(';') if d.strip())
    roots.extend(EXTRA_LVRT_ROOTS)
    roots.extend(STANDARD_LVRT_ROOTS)
    dirs: List[str] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            p = os.path.join(root, name)
            if os.path.isdir(p) and os.path.isfile(os.path.join(p, 'lvrt.dll')):
                dirs.append(p)
    dirs.sort(reverse=True)  # 新版本优先
    return dirs


def ensure_bridge_exe() -> str:
    """编译 32 位桥接宿主（源码 hash 缓存），返回 exe 路径。"""
    if not os.path.isfile(BRIDGE_SOURCE_PATH):
        raise SLMDriverError(f'桥接源码缺失: {BRIDGE_SOURCE_PATH}')
    csc = find_csc32()
    if not csc:
        raise SLMDriverError('未找到 32 位 csc.exe（.NET Framework v4）')
    try:
        with open(BRIDGE_SOURCE_PATH, 'rb') as fh:
            src_hash = hashlib.sha256(fh.read()).hexdigest()
    except OSError as exc:
        raise SLMDriverError(f'读取桥接源码失败: {exc}') from exc
    hash_path = BRIDGE_EXE_PATH + '.sha256'
    if (os.path.isfile(BRIDGE_EXE_PATH) and os.path.isfile(hash_path)
            and open(hash_path).read().strip() == src_hash):
        return BRIDGE_EXE_PATH
    os.makedirs(BRIDGE_BUILD_DIR, exist_ok=True)
    cmd = [csc, '/nologo', '/platform:x86', '/optimize+', '/warn:0',
           f'/out:{BRIDGE_EXE_PATH}', BRIDGE_SOURCE_PATH]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120,
                                encoding='mbcs', errors='replace',
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise SLMDriverError(f'桥接宿主编译失败: {exc}') from exc
    if result.returncode != 0 or not os.path.isfile(BRIDGE_EXE_PATH):
        raise SLMDriverError(f'桥接宿主编译失败: {result.stdout} {result.stderr}'.strip())
    with open(hash_path, 'w') as fh:
        fh.write(src_hash)
    return BRIDGE_EXE_PATH


class Bridge32Driver(SLMDriverBase):
    """
    通过 32 位 C# 桥接子进程调用 hpkSLMdaLV.dll（32 位 stdcall）。
    协议：stdin/stdout 每行一个 JSON；请求 {"id":N,"op":...}，响应 {"id":N,"ok":...}。
    """

    name = 'bridge32'

    def __init__(self):
        self._exe = ensure_bridge_exe()
        self._dll_path = REAL_DLL_PATH.replace(
            'hpkSLMdaLV_stdcall_64bit', 'hpkSLMdaLV_stdcall_32bit')
        if not os.path.isfile(self._dll_path):
            raise SLMDriverError(f'未找到 32 位 SDK DLL: {self._dll_path}')
        lvrt = find_lvrt_dirs()
        if not lvrt:
            raise SLMDriverError(
                '未发现 32 位 LabVIEW Runtime（含 lvrt.dll 的目录）。'
                '请确认 LabVIEW Runtime 已安装，或设置环境变量 USB_SLM_LVRT_DIRS。')
        self._search_dirs = ';'.join(lvrt)
        try:
            self._proc = subprocess.Popen(
                [self._exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except OSError as exc:
            raise SLMDriverError(f'桥接进程启动失败: {exc}') from exc
        self._lock = threading.Lock()
        self._rx: 'queue.Queue[Tuple[int, dict]]' = queue.Queue()
        self._reader = threading.Thread(target=self._read_loop, daemon=True,
                                        name='usb-slm-bridge32-rx')
        self._reader.start()
        self._next_id = 1
        # 握手
        hello = self._call('hello', timeout=15)
        if hello.get('arch') != 32:
            raise SLMDriverError(f'桥接进程位数异常: {hello.get("arch")}（应为 32）')
        self._loaded = False

    # ---- 进程通信 ----
    def _read_loop(self) -> None:
        try:
            for raw in self._proc.stdout:
                line = raw.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode('utf-8'))
                    self._rx.put((int(msg.get('id', -1)), msg))
                except (ValueError, TypeError):
                    logger.warning('桥接协议异常行: %r', line[:120])
        except (OSError, ValueError):
            pass
        finally:
            self._rx.put((-1, {'ok': False, 'error': '桥接进程已退出'}))

    def _call(self, op: str, timeout: float = 30.0, **params) -> dict:
        with self._lock:
            if self._proc.poll() is not None:
                raise SLMDriverError('桥接进程已退出')
            req = dict(params)
            req['op'] = op
            req_id = self._next_id
            self._next_id += 1
            req['id'] = req_id
            try:
                self._proc.stdin.write(
                    json.dumps(req, ensure_ascii=False).encode('utf-8') + b'\n')
                self._proc.stdin.flush()
            except (OSError, ValueError) as exc:
                raise SLMDriverError(f'桥接进程写入失败: {exc}') from exc
            deadline = time.time() + timeout
            while True:
                remain = deadline - time.time()
                if remain <= 0:
                    raise SLMDriverError(f'桥接调用 {op} 超时（{timeout}s）')
                try:
                    msg_id, msg = self._rx.get(timeout=remain)
                except queue.Empty:
                    continue
                if msg_id == -1:
                    raise SLMDriverError(msg.get('error', '桥接进程已退出'))
                if msg_id != req_id:
                    continue  # 丢弃过期响应（理论上不会发生）
                if not msg.get('ok'):
                    raise SLMDriverError(msg.get('error', f'{op} 调用失败'))
                return msg

    def close(self) -> None:
        if getattr(self, '_closed', False):
            return
        self._closed = True
        try:
            if self._proc.poll() is None:
                try:
                    self._call('quit', timeout=3)
                except SLMDriverError:
                    pass
                try:
                    self._proc.terminate()
                except OSError:
                    pass
                try:
                    self._proc.wait(timeout=5)
                except (subprocess.TimeoutExpired, OSError):
                    pass
        finally:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
            except OSError:
                pass

    def __del__(self):
        try:
            self.close()
        except Exception:  # noqa: BLE001
            pass

    # ---- SDK 18 函数（经桥） ----
    def _require_loaded(self):
        if not self._loaded:
            self._call('load', dll_path=self._dll_path, search_dirs=self._search_dirs)
            self._loaded = True

    def open_dev(self, probe_count: int = 8) -> List[int]:
        self._require_loaded()
        resp = self._call('open_dev', probe=probe_count)
        return [int(b) for b in resp.get('devices', [])]

    def close_dev(self, bids: List[int]) -> None:
        self._require_loaded()
        self._call('close_dev', bids=[int(b) for b in bids])

    def check_head_serial(self, bid: int) -> str:
        self._require_loaded()
        return str(self._call('check_head_serial', bid=int(bid)).get('serial', ''))

    def write_fmem_array(self, bid: int, data: bytes, slot: int) -> None:
        slot = validate_fmem_slot(slot)
        if len(data) != ARRAY_SIZE:
            raise SLMDriverError(f'图像数据必须为 {ARRAY_SIZE} 字节，收到 {len(data)}')
        self._require_loaded()
        self._call('write_fmem_array', bid=int(bid), slot=slot,
                   data_b64=base64.b64encode(data).decode('ascii'))

    def write_fmem_bmp_path(self, bid: int, path: str, slot: int) -> None:
        validate_fmem_slot(slot)
        if not os.path.isfile(path):
            raise SLMDriverError(f'BMP 文件不存在: {path}')
        self._require_loaded()
        self._call('write_fmem_bmp_path', bid=int(bid), slot=slot, path=path)

    def change_disp_slot(self, bid: int, slot: int) -> None:
        validate_fmem_slot(slot)
        self._require_loaded()
        self._call('change_disp_slot', bid=int(bid), slot=slot)

    def check_temp(self, bid: int) -> Tuple[float, float]:
        self._require_loaded()
        resp = self._call('check_temp', bid=int(bid))
        return float(resp.get('head_temp', 0)), float(resp.get('cb_temp', 0))

    def _read_image(self, op: str, bid: int, slot: Optional[int]) -> bytes:
        self._require_loaded()
        params = {'bid': int(bid)}
        if slot is not None:
            params['slot'] = int(slot)
        resp = self._call(op, **params)
        return base64.b64decode(resp.get('image_b64', ''))

    def check_fmem_slot(self, bid: int, slot: int) -> bytes:
        validate_fmem_slot(slot)
        return self._read_image('check_fmem_slot', bid, slot)

    def check_disp_img(self, bid: int) -> bytes:
        return self._read_image('check_disp_img', bid, None)

    def mode_select(self, bid: int, mode: int) -> None:
        validate_mode(mode)
        self._require_loaded()
        self._call('mode_select', bid=int(bid), mode=int(mode))

    def mode_check(self, bid: int) -> int:
        self._require_loaded()
        return int(self._call('mode_check', bid=int(bid)).get('value', 0))

    def check_led(self, bid: int) -> int:
        self._require_loaded()
        return int(self._call('check_led', bid=int(bid)).get('value', 0))

    def check_io(self, bid: int) -> int:
        self._require_loaded()
        return int(self._call('check_io', bid=int(bid)).get('value', 0))

    def reboot(self, bid: int) -> None:
        self._require_loaded()
        self._call('reboot', bid=int(bid))
        self._loaded = False  # 重启后 USB 中断

    def write_sd_bmp_path(self, bid: int, path: str, slot: int) -> None:
        validate_sd_slot(slot)
        if not os.path.isfile(path):
            raise SLMDriverError(f'BMP 文件不存在: {path}')
        self._require_loaded()
        self._call('write_sd_bmp_path', bid=int(bid), slot=slot, path=path)

    def write_sd_array(self, bid: int, data: bytes, slot: int) -> None:
        slot = validate_sd_slot(slot)
        if len(data) != ARRAY_SIZE:
            raise SLMDriverError(f'图像数据必须为 {ARRAY_SIZE} 字节，收到 {len(data)}')
        self._require_loaded()
        self._call('write_sd_array', bid=int(bid), slot=slot,
                   data_b64=base64.b64encode(data).decode('ascii'))

    def check_sd_slot(self, bid: int, slot: int) -> bytes:
        validate_sd_slot(slot)
        return self._read_image('check_sd_slot', bid, slot)

    def upload_sd_to_fmem(self, bid: int, sd_slot: int, fmem_slot: int) -> None:
        validate_sd_slot(sd_slot)
        validate_fmem_slot(fmem_slot)
        self._require_loaded()
        self._call('upload_sd_to_fmem', bid=int(bid), sd_slot=sd_slot, fmem_slot=fmem_slot)


# ==================== DLL 可用性探测 ====================
_PROBE_SNIPPET = (
    'import ctypes, os, sys\n'
    f'p = {REAL_DLL_PATH!r}\n'
    'os.add_dll_directory(os.path.dirname(p))\n'
    'ctypes.WinDLL(p)\n'
    'print("OK")\n'
)


def real_driver_available(timeout: float = 4.0) -> bool:
    """
    子进程探测 hpkSLMdaLV.dll 是否可加载。
    LabVIEW DLL 初始化可能长时间阻塞甚至弹窗，必须在独立子进程中探测并限时。
    """
    if not os.path.isfile(REAL_DLL_PATH):
        return False
    try:
        result = subprocess.run(
            [sys.executable, '-c', _PROBE_SNIPPET],
            capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return result.returncode == 0 and 'OK' in result.stdout
    except (subprocess.TimeoutExpired, OSError):
        return False


# ==================== 序列播放器（对应 exe 的 Sequence.csv） ====================
def parse_sequence_csv(text: str) -> List[dict]:
    """
    解析与 USB_SLMControl.exe 相同格式的序列文件:
        Slot No.,Duration Time / msec
        0,50
        1,50
    返回 [{'slot': int, 'duration_ms': int}, ...]
    """
    steps = []
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if not row or len(row) < 2:
            continue
        first = row[0].strip()
        if not first or first.lstrip('\ufeff').lower().startswith('slot'):
            continue  # 表头
        try:
            slot = int(float(first))
            duration = int(float(row[1].strip()))
        except (ValueError, IndexError):
            continue
        steps.append({'slot': slot, 'duration_ms': duration})
    if not steps:
        raise SLMDriverError('序列内容为空或格式非法（应为 "Slot No.,Duration Time / msec" 两列）')
    return steps


class USB_SLMController:
    """线程安全的控制器单例：驱动管理 + 序列播放线程。"""

    _instance_lock = threading.Lock()

    def __init__(self):
        self._lock = threading.RLock()
        self._driver: Optional[SLMDriverBase] = None
        self._driver_name = None
        self._devices: List[int] = []
        self._current_bid: Optional[int] = None
        # 序列播放状态
        self._seq_thread: Optional[threading.Thread] = None
        self._seq_stop = threading.Event()
        self._seq_state = {
            'playing': False,
            'steps': [],
            'index': 0,
            'loop': True,
            'iterations': 0,
            'current_slot': None,
            'started_at': None,
            'error': None,
        }

    # ---- 单例 ----
    _instance: Optional['USB_SLMController'] = None

    @classmethod
    def instance(cls) -> 'USB_SLMController':
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # ---- 连接管理 ----
    def connect(self, driver: str = 'auto', probe_count: int = 8) -> dict:
        with self._lock:
            if self._driver is not None:
                return self.status()
            errors = []
            if driver in ('auto', 'real'):
                try:
                    drv = LVRealDriver()
                except SLMDriverError as exc:
                    errors.append(f'真实驱动: {exc}')
                    drv = None
                if drv is not None:
                    try:
                        devices = drv.open_dev(probe_count)
                    except Exception as exc:  # noqa: BLE001 硬件调用异常统一转驱动错误
                        errors.append(f'真实驱动 Open_Dev: {exc}')
                        drv = None
                    else:
                        if not devices:
                            errors.append('真实驱动: 未发现 USB 连接的 LCOS-SLM 控制器')
                            drv = None
                        else:
                            self._driver, self._driver_name = drv, 'real'
                            self._devices = devices
                            self._current_bid = devices[0]
                            return self.status()
            if driver in ('auto', 'bridge32') and self._driver is None:
                drv = None
                try:
                    drv = Bridge32Driver()
                    devices = drv.open_dev(probe_count)
                except Exception as exc:  # noqa: BLE001
                    errors.append(f'32位桥接: {exc}')
                    if isinstance(exc, SLMDriverError) and driver == 'auto' \
                            and '未发现' not in str(exc):
                        logger.warning('bridge32 故障: %s', exc)
                    drv = None
                else:
                    if not devices:
                        errors.append('32位桥接: 未发现 USB 连接的 LCOS-SLM 控制器')
                        drv.close()
                        drv = None
                    else:
                        self._driver, self._driver_name = drv, 'bridge32'
                        self._devices = devices
                        self._current_bid = devices[0]
                        return self.status()
                if drv is not None and driver == 'bridge32':
                    drv.close()
                    drv = None
            if driver in ('auto', 'sim') and self._driver is None:
                drv = SimulatedDriver()
                devices = drv.open_dev(probe_count)
                self._driver, self._driver_name = drv, 'sim'
                self._devices = devices
                self._current_bid = devices[0]
                return self.status()
            raise SLMDriverError('；'.join(errors) or '无可用的驱动后端')

    def disconnect(self) -> dict:
        with self._lock:
            self.stop_sequence()
            if self._driver is not None:
                try:
                    self._driver.close_dev(self._devices)
                except Exception as exc:  # noqa: BLE001
                    logger.warning('Close_Dev 异常: %s', exc)
                if isinstance(self._driver, Bridge32Driver):
                    self._driver.close()
            self._driver = None
            self._driver_name = None
            self._devices = []
            self._current_bid = None
            return self.status()

    def reboot(self, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            self.stop_sequence()
            drv.reboot(bid)
            if isinstance(drv, Bridge32Driver):
                drv.close()
            # 手册: 重启后 USB 中断，需重新 Open_Dev
            self._driver = None
            self._driver_name = None
            self._devices = []
            self._current_bid = None
            return self.status()

    def _require_connected(self, bid: Optional[int]) -> Tuple[SLMDriverBase, int]:
        if self._driver is None:
            raise SLMDriverError('设备未连接，请先连接 SLM 控制器')
        if bid is None:
            bid = self._current_bid if self._current_bid is not None else 0
        bid = int(bid)
        if self._devices and bid not in self._devices:
            raise SLMDriverError(f'bID={bid} 不在已连接设备列表 {self._devices} 中')
        return self._driver, bid

    # ---- 状态 ----
    def status(self) -> dict:
        with self._lock:
            return {
                'connected': self._driver is not None,
                'driver': self._driver_name,
                'real_driver_available': real_driver_available_cached(),
                'bridge32_available': bridge32_available_cached(),
                'devices': list(self._devices),
                'current_bid': self._current_bid,
                'current_slot': (self._seq_state.get('current_slot')
                                 if self._seq_state['playing'] else None),
                'sequence': self.sequence_state(),
            }

    def device_info(self, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            head, cb = drv.check_temp(bid)
            return {
                'bid': bid,
                'head_serial': drv.check_head_serial(bid),
                'mode': drv.mode_check(bid),
                'mode_text': 'USB/Trigger' if drv.mode_check(bid) == MODE_USB_TRIGGER else 'DVI',
                'head_temp': head,
                'cb_temp': cb,
                'led_status': drv.check_led(bid),
                'io_status': drv.check_io(bid),
            }

    # ---- 帧存储器 ----
    def write_fmem(self, data: bytes, slot: int, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            drv.write_fmem_array(bid, data, slot)
            return {'bid': bid, 'slot': validate_fmem_slot(slot), 'written': True}

    def write_fmem_bmp(self, path: str, slot: int, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            drv.write_fmem_bmp_path(bid, path, slot)
            return {'bid': bid, 'slot': validate_fmem_slot(slot), 'written': True}

    def write_fmem_sequence(self, frames: List[bytes], steps: List[dict],
                            loop: bool = True, bid: Optional[int] = None,
                            require_real: bool = False) -> dict:
        """Atomically replace FMem slots and start a sequence.

        The controller lock covers the connection check, playback check, all
        writes, and the first display-slot switch.  Existing slot contents are
        restored when any write or start step fails.
        """
        with self._lock:
            drv, bid = self._require_connected(bid)
            if require_real and self._driver_name == 'sim':
                raise SLMDriverError('当前连接使用模拟驱动；请连接真实 SLM 后再执行实时上传')
            if self._seq_state['playing']:
                raise SLMDriverError('设备已有序列正在播放')
            if not frames or len(frames) != len(steps):
                raise SLMDriverError('相位帧与序列步骤数量不一致')

            normalized_steps = []
            slots = []
            for index, step in enumerate(steps):
                try:
                    slot = validate_fmem_slot(step['slot'])
                    duration = int(step['duration_ms'])
                    if not (1 <= duration <= 3600000):
                        raise ValueError
                except (KeyError, TypeError, ValueError, SLMDriverError):
                    raise SLMDriverError(
                        f'第 {index + 1} 步非法: 需要 slot(0~818) 与 duration_ms(>=1)'
                    ) from None
                if len(frames[index]) != ARRAY_SIZE:
                    raise SLMDriverError(
                        f'第 {index + 1} 帧图像数据必须为 {ARRAY_SIZE} 字节'
                    )
                normalized_steps.append({'slot': slot, 'duration_ms': duration})
                slots.append(slot)

            # Back up every target slot before the first write.  Duplicate
            # slots are allowed by the low-level API, but backing up once keeps
            # rollback deterministic and restores the original value.
            backups = {}
            try:
                for slot in dict.fromkeys(slots):
                    backups[slot] = drv.check_fmem_slot(bid, slot)
            except Exception as exc:  # noqa: BLE001
                raise SLMSequenceUploadError(
                    f'读取原有 FMem 槽位失败: {exc}', 0, []
                ) from exc

            uploaded = 0
            try:
                for frame, step in zip(frames, normalized_steps):
                    drv.write_fmem_array(bid, frame, step['slot'])
                    uploaded += 1
                sequence = self.start_sequence(normalized_steps, loop=loop, bid=bid)
                return {
                    'bid': bid,
                    'uploaded_count': uploaded,
                    'sequence': sequence,
                }
            except Exception as exc:  # noqa: BLE001
                restore_failed = []
                for slot, previous in backups.items():
                    try:
                        drv.write_fmem_array(bid, previous, slot)
                    except Exception:  # noqa: BLE001
                        restore_failed.append(slot)
                detail = f'批量写入或启动序列失败: {exc}'
                if restore_failed:
                    detail += f'；回滚失败槽位: {restore_failed}'
                raise SLMSequenceUploadError(
                    detail, uploaded, restore_failed
                ) from exc

    def display(self, slot: int, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            drv.change_disp_slot(bid, slot)
            return {'bid': bid, 'slot': validate_fmem_slot(slot), 'displayed': True}

    def read_fmem(self, slot: int, bid: Optional[int] = None) -> bytes:
        with self._lock:
            drv, bid = self._require_connected(bid)
            return drv.check_fmem_slot(bid, slot)

    def read_display(self, bid: Optional[int] = None) -> bytes:
        with self._lock:
            drv, bid = self._require_connected(bid)
            return drv.check_disp_img(bid)

    # ---- SD 卡 ----
    def write_sd(self, data: bytes, slot: int, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            drv.write_sd_array(bid, data, slot)
            return {'bid': bid, 'slot': validate_sd_slot(slot), 'written': True}

    def write_sd_bmp(self, path: str, slot: int, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            drv.write_sd_bmp_path(bid, path, slot)
            return {'bid': bid, 'slot': validate_sd_slot(slot), 'written': True}

    def read_sd(self, slot: int, bid: Optional[int] = None) -> bytes:
        with self._lock:
            drv, bid = self._require_connected(bid)
            return drv.check_sd_slot(bid, slot)

    def upload_sd_to_fmem(self, sd_slot: int, fmem_slot: int, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            drv.upload_sd_to_fmem(bid, sd_slot, fmem_slot)
            return {'bid': bid, 'sd_slot': validate_sd_slot(sd_slot),
                    'fmem_slot': validate_fmem_slot(fmem_slot), 'uploaded': True}

    def set_mode(self, mode: int, bid: Optional[int] = None) -> dict:
        with self._lock:
            drv, bid = self._require_connected(bid)
            validate_mode(mode)
            drv.mode_select(bid, mode)
            if drv.name == 'sim':
                note = '模拟模式立即生效'
            else:
                note = '模式切换在控制器重启后生效'
            return {'bid': bid, 'mode': mode, 'note': note}

    # ---- 序列播放 ----
    def start_sequence(self, steps: List[dict], loop: bool = True,
                       bid: Optional[int] = None) -> dict:
        with self._lock:
            if self._driver is None:
                raise SLMDriverError('设备未连接，请先连接 SLM 控制器')
            if not steps:
                raise SLMDriverError('序列步骤为空')
            if self._seq_state['playing']:
                raise SLMDriverError('序列正在播放中，请先停止')
            for i, step in enumerate(steps):
                try:
                    validate_fmem_slot(step['slot'])
                    if not (1 <= int(step['duration_ms']) <= 3600000):
                        raise ValueError
                except (KeyError, TypeError, ValueError):
                    raise SLMDriverError(
                        f'第 {i + 1} 步非法: 需要 slot(0~818) 与 duration_ms(>=1)') from None
            self._seq_stop.clear()
            self._seq_state = {
                'playing': True, 'steps': list(steps), 'index': 0,
                'loop': bool(loop), 'iterations': 0,
                'current_slot': None,
                'started_at': time.time(),
                'error': None,
            }
            # Confirm the first frame before reporting a playing sequence.
            # A failed switch leaves the controller idle and does not spawn a
            # thread that would otherwise look successful to callers.
            first_slot = int(steps[0]['slot'])
            try:
                self._driver.change_disp_slot(
                    int(bid if bid is not None else self._current_bid or 0),
                    first_slot,
                )
            except Exception as exc:  # noqa: BLE001
                self._seq_state = {
                    'playing': False, 'steps': [], 'index': 0,
                    'loop': bool(loop), 'iterations': 0,
                    'current_slot': None, 'started_at': None,
                    'error': str(exc),
                }
                raise SLMDriverError(f'首帧切槽失败: {exc}') from exc
            self._seq_state['current_slot'] = first_slot
            self._seq_thread = threading.Thread(
                target=self._sequence_loop, args=(int(bid if bid is not None
                                                      else self._current_bid or 0),),
                daemon=True, name='usb-slm-sequence')
            self._seq_thread.start()
            return self.sequence_state()

    def _sequence_loop(self, bid: int) -> None:
        try:
            while not self._seq_stop.is_set():
                steps = self._seq_state['steps']
                for idx, step in enumerate(steps):
                    if self._seq_stop.is_set():
                        return
                    slot = int(step['slot'])
                    duration = max(0, int(step['duration_ms'])) / 1000.0
                    with self._lock:
                        if self._driver is None:
                            return
                        try:
                            self._driver.change_disp_slot(bid, slot)
                        except Exception as exc:  # noqa: BLE001
                            logger.warning('序列切槽失败: %s', exc)
                            self._seq_state['error'] = str(exc)
                            self._seq_stop.set()
                            return
                        self._seq_state['index'] = idx
                        self._seq_state['current_slot'] = slot
                    # 分片睡眠保证可及时停止
                    end_t = time.time() + duration
                    while not self._seq_stop.is_set():
                        remain = end_t - time.time()
                        if remain <= 0:
                            break
                        time.sleep(min(remain, 0.02))
                with self._lock:
                    self._seq_state['iterations'] += 1
                if not self._seq_state['loop']:
                    break
        finally:
            with self._lock:
                self._seq_state['playing'] = False
                self._seq_state['current_slot'] = None

    def stop_sequence(self) -> dict:
        with self._lock:
            self._seq_stop.set()
            thread = self._seq_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        with self._lock:
            self._seq_thread = None
            return self.sequence_state()

    def sequence_state(self) -> dict:
        st = self._seq_state
        total_ms = sum(int(s.get('duration_ms', 0)) for s in st['steps'])
        return {
            'playing': st['playing'],
            'steps': list(st['steps']),
            'frame_count': len(st['steps']),
            'total_ms': total_ms,
            'index': st['index'],
            'current_slot': st['current_slot'],
            'loop': st['loop'],
            'iterations': st['iterations'],
            'started_at': st['started_at'],
            'error': st.get('error'),
        }

    @property
    def driver_name(self) -> Optional[str]:
        return self._driver_name


_real_available_cache = {'value': None, 'ts': 0.0}
_real_cache_lock = threading.Lock()


def real_driver_available_cached(ttl: float = 30.0) -> bool:
    """缓存版 DLL 可用性探测（子进程探测涉及解释器启动，需限流）。"""
    now = time.time()
    with _real_cache_lock:
        if _real_available_cache['value'] is None or now - _real_available_cache['ts'] > ttl:
            _real_available_cache['value'] = real_driver_available()
            _real_available_cache['ts'] = now
        return _real_available_cache['value']


def bridge32_available() -> bool:
    """32 位桥接链路静态可用性：csc.exe + 32 位 DLL + 32 位 LVRT 均存在。"""
    if not find_csc32():
        return False
    if not os.path.isfile(BRIDGE_SOURCE_PATH):
        return False
    dll32 = REAL_DLL_PATH.replace('hpkSLMdaLV_stdcall_64bit', 'hpkSLMdaLV_stdcall_32bit')
    if not os.path.isfile(dll32):
        return False
    return bool(find_lvrt_dirs())


_bridge_cache = {'value': None, 'ts': 0.0}
_bridge_cache_lock = threading.Lock()


def bridge32_available_cached(ttl: float = 60.0) -> bool:
    now = time.time()
    with _bridge_cache_lock:
        if _bridge_cache['value'] is None or now - _bridge_cache['ts'] > ttl:
            _bridge_cache['value'] = bridge32_available()
            _bridge_cache['ts'] = now
        return _bridge_cache['value']
