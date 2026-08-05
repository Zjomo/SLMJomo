from PIL import Image
import numpy as np
from ctypes import *
import copy


def main():
    # 像素间距（pixel pitch）：0 对应 20微米，1 对应 1.25微米
    pitch = 1

    # LCOS 设备的像素尺寸
    x = 1272
    y = 1024

    # LCOS-SML 显示器编号设置
    monitorNo = 2  # 监视器编号
    windowNo = 0  # 窗口编号
    xShift = 0  # X方向偏移像素数
    yShift = 0  # Y方向偏移像素数

    # 总像素数
    array_size = x * y

    # 定义 8位无符号整型数组类型
    FARRAY = c_uint8 * array_size

    # 创建 8位无符号整型数组实例
    farray = FARRAY(0)
    farray2 = FARRAY(0)
    farray3 = FARRAY(0)

    # 使用 DLL 显示轴棱锥透镜（Axicon Lens）图案数组
    top = 10.0  # 相位顶部值（以π弧度为单位）
    makeAxiconLensArray(top, pitch, x, y, farray)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray)

    # 使用 DLL 显示柱面透镜（Cylindrical Lens）图案数组
    forcus = 1000  # 焦距（单位：毫米）
    wavelength = 1064  # 光波长（单位：纳米）
    modeSelect = 0  # 模式选择
    makeCylindricalLensArray(forcus, wavelength, pitch, modeSelect, x, y, farray)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray)

    # 使用 DLL 显示旋转后的图案数组
    degree = 30.0  # 旋转角度（度）
    imageRotation(farray, degree, x, y, farray2)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray2)

    # 使用 DLL 显示衍射光栅（Diffraction Grating）图案数组
    rowOrColumn = 0  # 方向：0为水平，1为垂直
    gradiationNo = 16  # 灰度级数
    gradiationWidth = 16  # 每个灰度级的宽度（像素）
    slipFactor = 0  # 滑动因子
    makeDiffractionPatternArray(rowOrColumn, gradiationNo, gradiationWidth, slipFactor, x, y, farray)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray)

    # 使用 DLL 显示拉盖尔-高斯（Laguerre-Gauss）模式图案数组
    p = 1  # 径向指数
    m = 1  # 角向指数
    pitch = 1  # 像素间距
    beamSize = 20.0  # 光束大小（毫米）
    makeLaguerreGaussModeArray(p, m, pitch, beamSize, x, y, farray)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray)

    # 使用 DLL 显示菲涅尔透镜（Fresnel Lens）图案数组
    forcus = 1000  # 焦距（单位：毫米）
    wavelength = 1064  # 光波长（单位：纳米）
    makeFresnelLensArray(forcus, wavelength, pitch, x, y, farray2)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray2)

    # 使用 DLL 显示合成的菲涅尔透镜与拉盖尔-高斯模式图案数组
    phaseSynthsizer([farray, farray2], farray3)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray3)

    # 使用 DLL 显示来自图像文件的计算机生成全息图（CGH）图案
    filepath = "Target image sample\\char_hpk_128x128.bmp"
    makeBmpArray(filepath, x, y, farray)
    showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, farray)

    return 0


'''
生成轴棱锥透镜（Axicon Lens）图案数组的函数
参数：
    double top:     轴棱锥透镜图案的顶层相位值（以π弧度为单位）
    int pitch:      像素间距，0：20微米，1：1.25微米
    int x:          X方向的像素数量
    int y:          Y方向的像素数量
    array:          输出的8位无符号整型数组
返回值：
    int:            成功返回0，失败返回-1
'''


def makeAxiconLensArray(top, pitch, x, y, array):
    Lcoslib = windll.LoadLibrary("./Image_Control.dll")
    AxiconLens = Lcoslib.AxiconLens
    AxiconLens.argtyes = [c_double, c_int, c_int, c_int, c_void_p, c_void_p]
    AxiconLens.restype = c_int
    if (pitch != 0 and pitch != 1):
        print("错误：AxiconLensFunction - 无效的参数 (pitch)。")
        return -1
    # 调用DLL函数
    AxiconLens(c_double(top), pitch, x, y, byref(c_int(x * y)), byref(array))
    return 0


'''
生成柱面透镜（Cylindrical Lens）图案阵列的函数
参数：
    int focus:      柱面透镜的焦距（单位：毫米，mm）
    int wavelength: 光的波长（单位：纳米，nm）
    int pitch:      像素间距，0：20微米（20 µm）；1：1.25微米（1.25 µm）
    int modeSelect: 模式选择，0：水平方向；1：垂直方向
    int x:          X方向的像素数量
    int y:          Y方向的像素数量
    array:          输出的8位无符号整型数组（生成的图案数据）
返回值：
    int:            成功返回0，失败返回-1
'''


def makeCylindricalLensArray(forcus, wavelength, pitch, modeSelect, x, y, array):
    Lcoslib = windll.LoadLibrary("Image_Control.dll")
    CylindricalLens = Lcoslib.CylindricalLens
    CylindricalLens.argtyes = [c_int, c_int, c_int, c_int, c_int, c_int, c_void_p, c_void_p]
    CylindricalLens.restype = c_int
    if (pitch != 0 and pitch != 1):
        print("错误：CylindricalLensFunction - 无效的参数 (pitch)。")
        return -1
    CylindricalLens(forcus, wavelength, pitch, modeSelect, x, y, byref(c_int(x * y)), byref(array))
    return 0


'''
生成衍射光栅（Diffraction Grating）图案阵列的函数
参数：
    int rowOrColumn:    方向选择，0：水平，1：垂直
    int gradiationNo:   灰度级数
    int gradiationWidth:每个灰度级的宽度（像素）
    int slipFactor:     滑动因子
    int x:              X方向的像素数量
    int y:              Y方向的像素数量
    array:              输出的8位无符号整型数组
返回值：
    int:                成功返回0
'''


def makeDiffractionPatternArray(rowOrColumn, gradiationNo, gradiationWidth, slipFactor, x, y, array):
    Lcoslib = windll.LoadLibrary("Image_Control.dll")
    Diffraction_pattern = Lcoslib.Diffraction_pattern
    Diffraction_pattern.argtyes = [c_int, c_int, c_int, c_int, c_int, c_int, c_void_p, c_void_p]
    Diffraction_pattern.restype = c_int
    Diffraction_pattern(rowOrColumn, gradiationNo, gradiationWidth, slipFactor, x, y, byref(c_int(x * y)), byref(array))
    return 0


'''
生成拉盖尔-高斯（Laguerre-Gauss）模式图案阵列的函数
参数：
    int p:          径向指数
    int m:          角向指数
    int pitch:      像素间距，0：20微米，1：1.25微米
    double beamSize:光束大小（毫米）
    int x:          X方向的像素数量
    int y:          Y方向的像素数量
    array:          输出的8位无符号整型数组
返回值：
    int:            成功返回0，失败返回-1
'''


def makeLaguerreGaussModeArray(p, m, pitch, beamSize, x, y, array):
    Lcoslib = windll.LoadLibrary("Image_Control.dll")
    LaguerreGaussMode = Lcoslib.LaguerreGaussMode
    LaguerreGaussMode.argtyes = [c_int, c_int, c_int, c_double, c_int, c_int, c_void_p, c_void_p]
    LaguerreGaussMode.restype = c_int
    if (pitch != 0 and pitch != 1):
        print("错误：LaguerreGaussModeFunction - 无效的参数 (pitch)。")
        return -1
    LaguerreGaussMode(p, m, pitch, c_double(beamSize), x, y, byref(c_int(x * y)), byref(array))
    return 0


'''
生成菲涅尔透镜（Fresnel Lens）图案阵列的函数
参数：
    int focus:      透镜的焦距（单位：毫米）
    int wavelength: 光的波长（单位：纳米）
    int pitch:      像素间距，0：20微米，1：1.25微米
    int x:          X方向的像素数量
    int y:          Y方向的像素数量
    array:          输出的8位无符号整型数组
返回值：
    int:            成功返回0，失败返回-1
'''


def makeFresnelLensArray(forcus, wavelength, pitch, x, y, array):
    Lcoslib = windll.LoadLibrary("Image_Control.dll")
    FresnelLens = Lcoslib.FresnelLens
    FresnelLens.argtyes = [c_int, c_int, c_int, c_int, c_int, c_int, c_void_p, c_void_p]
    FresnelLens.restype = c_int
    if (pitch != 0 and pitch != 1):
        print("错误：FresnelLensFunction - 无效的参数 (pitch)。")
        return -1
    FresnelLens(forcus, wavelength, pitch, x, y, byref(c_int(x * y)), byref(array))
    return 0


'''
从图像文件生成计算机生成全息图（CGH）图案数组的函数
参数：
    String filepath: 图像文件路径
    int x:           X方向的像素数量（目标尺寸）
    int y:           Y方向的像素数量（目标尺寸）
    outArray:        输出的8位无符号整型数组
返回值：
    int:             成功返回0
'''


def makeBmpArray(filepath, x, y, outArray):
    im = Image.open(filepath)
    imageHeight, imageWidth = im.size
    im_gray = im.convert("L")

    print("图像尺寸 = {} x {}".format(imageWidth, imageHeight))

    # 将图像像素数据复制到输出数组中
    for i in range(imageWidth):
        for j in range(imageHeight):
            outArray[i + imageWidth * j] = im_gray.getpixel((i, j))

    Lcoslib = windll.LoadLibrary("Image_Control.dll")

    # 创建 CGH（计算机生成全息图）
    inArray = copy.deepcopy(outArray)
    Create_CGH_OC = Lcoslib.Create_CGH_OC
    Create_CGH_OC.argtyes = [c_void_p, c_int, c_int, c_int, c_int, c_void_p, c_void_p]
    Create_CGH_OC.restype = c_int

    repNo = 100  # 迭代次数
    progressBar = 1  # 是否显示进度条
    Create_CGH_OC(byref(inArray), repNo, progressBar, imageWidth, imageHeight, byref(c_int(imageHeight * imageWidth)),
                  byref(outArray))

    # 图像平铺（Tiling）处理
    inArray = copy.deepcopy(outArray)
    Image_Tiling = Lcoslib.Image_Tiling
    Image_Tiling.argtyes = [c_void_p, c_int, c_int, c_int, c_int, c_int, c_void_p, c_void_p]
    Image_Tiling.restype = c_int

    Image_Tiling(byref(inArray), imageWidth, imageHeight, imageHeight * imageWidth, x, y, byref(c_int(x * y)),
                 byref(outArray))

    return 0


'''
在LCOS显示器上显示图案的函数
参数：
    int monitorNo:  监视器编号
    int windowNo:   窗口编号
    int x:          X方向的像素数量
    int xShift:     X方向的偏移像素数
    int y:          Y方向的像素数量
    int yShift:     Y方向的偏移像素数
    array:          输入的8位无符号整型数组（要显示的图案数据）
返回值：
    int:            成功返回0
'''


def showOn2ndDisplay(monitorNo, windowNo, x, xShift, y, yShift, array):
    Lcoslib = windll.LoadLibrary("Image_Control.dll")

    # 选择 LCOS 显示窗口
    Window_Settings = Lcoslib.Window_Settings
    Window_Settings.argtypes = [c_int, c_int, c_int, c_int]
    Window_Settings.restype = c_int
    Window_Settings(monitorNo, windowNo, xShift, yShift)

    # 显示图案
    Window_Array_to_Display = Lcoslib.Window_Array_to_Display
    Window_Array_to_Display.argtypes = [c_void_p, c_int, c_int, c_int, c_int]
    Window_Array_to_Display.restype = c_int
    Window_Array_to_Display(array, x, y, windowNo, x * y)

    # 等待用户按回车键继续
    input("请按回车键继续...")

    # 关闭窗口
    Window_Term = Lcoslib.Window_Term
    Window_Term.argtyes = [c_int]
    Window_Term.restype = c_int
    Window_Term(windowNo)

    return 0


'''
图像旋转函数
参数：
    inputArray:     输入的1维数组
    double degree:  旋转角度（度）
    int x:          X方向的像素数量
    int y:          Y方向的像素数量
    outputArray:    输出的1维数组
返回值：
    int:            成功返回0
'''


def imageRotation(inputArray, degree, x, y, outputArray):
    Lcoslib = windll.LoadLibrary("Image_Control.dll")

    Image_Rotation = Lcoslib.Image_Rotation
    Image_Rotation.argtyes = [c_void_p, c_double, c_int, c_int, c_void_p, c_void_p]
    Image_Rotation.restype = c_int
    Image_Rotation(byref(inputArray), c_double(degree), x, y, byref(c_int(x * y)), byref(outputArray))

    return 0


'''
相位图案合成函数
参数：
    inputPatterns:  要合成的图案组件列表（二维数组）
    outputArray:    输出的1维数组
返回值：
    int:            成功返回0
'''


def phaseSynthsizer(inputPatterns, outputArray):
    n = len(inputPatterns[0])
    outputPattern = np.zeros(n, dtype=int)
    # 将所有图案组件相加
    for pattern in inputPatterns:
        outputPattern = outputPattern + pattern

    # 对256取模，确保值在0-255范围内
    for i in range(n):
        outputArray[i] = c_uint8(outputPattern[i] % 256)

    return 0


if __name__ == "__main__":
    main()