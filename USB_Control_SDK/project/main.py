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
