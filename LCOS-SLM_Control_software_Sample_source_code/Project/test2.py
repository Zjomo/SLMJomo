import ctypes
from ctypes import *


# 1. 加载 DLL（python 调用C语言编写的DLL文件库）
dll = ctypes.CDLL("./DLL/hpkSLMdaLV.dll")  # cdecl


# 2. 定义函数原型【定义输入参数、输出参数的类型】
# 打开设备，并返回设备数量
# int32_t Open_Dev(uint8_t bIDList[], int32_t bIDSize)
dll.Open_Dev.argtypes = [POINTER(c_uint8), c_int32]
dll.Open_Dev.restype  = c_int32


# 关闭设备
# int32_t Close_Dev(uint8_t bIDList[], int32_t bIDSize)
dll.Close_Dev.argtypes = [POINTER(c_uint8), c_int32]
dll.Close_Dev.restype  = c_int32

# 读取设备的序列号
# int32_t Check_HeadSerial(uint8_t bID, char HeadSerial[], int32_t CharSize)
dll.Check_HeadSerial.argtypes = [c_uint8, c_char_p, c_int32]
dll.Check_HeadSerial.restype  = c_int32

# 读取设备头部和控制板的温度
# int32_t Check_Temp(uint8_t bID, double *HeadTemp, double *CBTemp)
dll.Check_Temp.argtypes = [c_uint8, POINTER(c_double), POINTER(c_double)]
dll.Check_Temp.restype  = c_int32


# 3. 通信验证流程
# 假设最多连接 4 台设备
MAX_DEV = 4
bID_list = (c_uint8 * MAX_DEV)()

# ---- Step 1: 打开设备 ----
dev_count = dll.Open_Dev(bID_list, MAX_DEV)
print("已连接的设备数为:", dev_count)

if dev_count <= 0:
    raise RuntimeError("❌ 未检测到 LCOS-SLM 设备")

bID = bID_list[0]
print("设备通信序号:", bID)

# ---- Step 2: 读取头部序列号 ----
serial_buf = create_string_buffer(11)  # 固定 11 字符
ret = dll.Check_HeadSerial(bID, serial_buf, 11)

if ret != 1:
    raise RuntimeError("❌ 读取 Head Serial 失败")

print("设备头部序号:", serial_buf.value.decode())

# ---- Step 3: 读取温度 ----
head_temp = c_double()
cb_temp   = c_double()

ret = dll.Check_Temp(bID, byref(head_temp), byref(cb_temp))
if ret != 1:
    raise RuntimeError("❌ 读取温度失败")

print(f"Head Temp: {head_temp.value:.2f} °C")
print(f"Board Temp: {cb_temp.value:.2f} °C")

# ---- Step 4: 关闭设备 ----
dll.Close_Dev(bID_list, dev_count)
print("✅ 通信验证完成，设备已关闭")


######### 从DVI模型 转成 USB模式

# 设置模式切换
dll.Mode_Select.argtypes = [c_uint8, c_uint8]
dll.Mode_Select.restype  = c_int32

ret = dll.Mode_Select(bID, 1)  # 1 = USB / Trigger
print("Mode_Select:", ret)

# 重启 USB连接
dll.Reboot(bID)

# 等 USB 重新枚举（非常重要）
import time
time.sleep(5)

# 重新 Open_Dev
dll.Open_Dev(bID_list, len(bID_list))
bID = bID_list[0]

######### 验证当前的模式
dll.Mode_Check.argtypes = [c_uint8, POINTER(c_uint32)]
dll.Mode_Check.restype  = c_int32

mode = c_uint32()
ret = dll.Mode_Check(bID, byref(mode))

print("Mode_Check ret:", ret)
print("切换设备(%s)模式为：%s"%(bID,mode.value))  # 0=DVI, 1=USB/Trigger


import numpy as np
from PIL import Image

SLM_WIDTH  = 1272
SLM_HEIGHT = 1024
SLM_SIZE   = SLM_WIDTH * SLM_HEIGHT

image_path = r'C:\Users\Mr\Desktop\光学工程交叉\空间光调制器\空间光调制器光盘\LCOS-SLM_USB_SLMControl\Test_sample_image_1272x1024\000_1272x1024.bmp'

"""
读取任意图像 → 转成 SLM 所需的一维 uint8 数组
"""
# 1. 读取并转为灰度
img = Image.open(image_path).convert("L")

# 2. resize 到 SLM 分辨率，并转换成 np
img = img.resize((SLM_WIDTH, SLM_HEIGHT), Image.BILINEAR)
arr = np.asarray(img, dtype=np.uint8)

# 3. 展平成 1D（行优先）
arr_1d = arr.flatten()



import ctypes
from ctypes import *

# 写入SLM 声明函数 的 输入参数
dll.Write_FMemArray.argtypes = [
    c_uint8,                 # bID，设备ID
    POINTER(c_uint8),         # ArrayIn，指针 (uint8类型)
    c_int32,                  # ArraySize，数组大小 (32位有符号整数)
    c_uint32, c_uint32,       # XPixel, YPixel，图像的宽、高
    c_uint32                  # SlotNo，帧缓冲区 插槽号
]

# 写入SLM的声明函数 的 输出参数
dll.Write_FMemArray.restype = c_int32

# 切换SLM画板 声明函数 的 输入/输出参数
dll.Change_DispSlot.argtypes = [c_uint8, c_uint32]
dll.Change_DispSlot.restype  = c_int32


bID = bID_list[0]    # 已连接 设备通信ID
slot=0             # 显示缓存槽位为：1

"""
输入图像文件，SLM 显示
"""
# 1. 准备数据
img_data = arr_1d    # 一维化的图像数据

# python数组 转 ctypes 数组指针
c_array = (c_uint8 * img_data.size)(*img_data)

# 2. 写入帧内存
ret = dll.Write_FMemArray(
    bID,
    c_array,
    img_data.size,
    SLM_WIDTH,
    SLM_HEIGHT,
    slot
)

if ret != 1:
    raise RuntimeError("❌ Write_FMemArray 失败")

# 3. 切换显示 slot
ret = dll.Change_DispSlot(bID, slot)
if ret != 1:
    raise RuntimeError("❌ Change_DispSlot 失败")

print("✅ SLM 已显示图像:", image_path)
