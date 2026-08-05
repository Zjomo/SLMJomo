from ctypes import *
from PIL import Image
import numpy as np
import copy

# SLM 参数
SLM_X = 1272
SLM_Y = 1024
MONITOR_NO = 2  # SLM 作为第二显示器
WINDOW_NO = 0
XSHIFT = 0
YSHIFT = 0

# 加载 DLL
Lcoslib = windll.LoadLibrary("./Image_Control.dll")

# ------------------------------------------------------------------
# 1. 加载 BMP 并转换为 CGH 数组
# ------------------------------------------------------------------
def generate_cgh_array_from_bmp(filepath):
    # 读取 BMP
    im = Image.open(filepath)
    im = im.convert("L")  # 灰度化
    # 缩放到 SLM 分辨率
    im = im.resize((SLM_X, SLM_Y))
    width, height = im.size

    # 填充到 1D 数组
    array_size = SLM_X * SLM_Y
    FARRAY = c_uint8 * array_size
    outArray = FARRAY(0)

    for i in range(width):
        for j in range(height):
            outArray[j*width + i] = im.getpixel((i,j))

    # 调用 DLL 生成 CGH
    inArray = copy.deepcopy(outArray)

    Create_CGH_OC = Lcoslib.Create_CGH_OC
    Create_CGH_OC.argtypes = [c_void_p, c_int, c_int, c_int, c_int, c_void_p, c_void_p]
    Create_CGH_OC.restype = c_int

    repNo = 50     # 迭代次数，可调整
    progressBar = 1  # 显示进度

    # 生成 CGH
    Create_CGH_OC(byref(inArray),
                  c_int(repNo),
                  c_int(progressBar),
                  c_int(width),
                  c_int(height),
                  byref(c_int(width*height)),
                  byref(outArray))

    return outArray


# ------------------------------------------------------------------
# 2. 显示数组到 SLM（第二显示器）
# ------------------------------------------------------------------
def show_on_slm(array):
    # 选择窗口
    Window_Settings = Lcoslib.Window_Settings
    Window_Settings.argtypes = [c_int, c_int, c_int, c_int]
    Window_Settings.restype = c_int
    Window_Settings(MONITOR_NO, WINDOW_NO, XSHIFT, YSHIFT)

    # 发送数组
    Window_Array_to_Display = Lcoslib.Window_Array_to_Display
    Window_Array_to_Display.argtypes = [c_void_p, c_int, c_int, c_int, c_int]
    Window_Array_to_Display.restype = c_int
    Window_Array_to_Display(array, SLM_X, SLM_Y, WINDOW_NO, SLM_X*SLM_Y)

    print("已发送图案到 SLM 显示，请观察光学系统...")
    input("按回车发送下一帧 / 退出")

    # 关闭显示窗口
    Window_Term = Lcoslib.Window_Term
    Window_Term.argtypes = [c_int]
    Window_Term.restype = c_int
    Window_Term(WINDOW_NO)


# ------------------------------------------------------------------
# 主程序
# ------------------------------------------------------------------
if __name__ == "__main__":
    bmp_file = "./image/1.bmp"  # 你的 BMP 文件
    cgh_array = generate_cgh_array_from_bmp(bmp_file)
    show_on_slm(cgh_array)
    print("结束！")
