# 🔮 LCOS-SLM 专业控制面板 v3.0

## 🎯 项目概述

这是一个基于 **Flask + JavaScript + SQLite** 的LCOS-SLM专业控制Web应用，集成了**所有常见SLM相位图生成功能**和 **CGH Simulation（计算机生成全息图模拟）**。

本项目参考了 `matlab_SLM_功能模块参考代码` 中的所有MATLAB实现，完整模拟官方SLM软件UI界面，提供专业级的工作流程控制和实时预览功能。

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd web_app
pip install -r requirements.txt
```

### 2. 启动应用

```bash
# Windows
start.bat

# Linux/Mac
./start.sh

# 或手动启动
python app.py
```

### 3. 访问界面

打开浏览器访问：**http://127.0.0.1:5000/**

> 基础版已移除，现在只有专业版界面。

---

## 🎨 核心功能模块

### 1. 🔍 菲涅尔透镜 (Fresnel Lens)

**参考**: `fresnellens.m`

生成标准菲涅尔透镜相位调制图案，支持会聚/发散透镜。

**参数**：
- focal_length: 焦距（mm），正数为会聚，负数为发散
- wavelength: 波长（nm）
- pixel_size: 像素尺寸（mm），默认25μm

### 2. 🔺 轴棱锥透镜 (Axicon Lens)

**参考**: `axicon.m`

产生贝塞尔光束的相位图。

**参数**：
- radius: 相位周期半径（像素）

### 3. 🔷 闪耀光栅 (Blaze Grating)

**参考**: `blazegrating.m`

锯齿相位光栅，用于光束偏转。

**参数**：
- period: 光栅周期（像素）
- angle: 旋转角度（°）

### 4. 📐 正弦光栅 (Sine Grating)

**参考**: `sinegrating.m`

正弦变化的相位光栅。

**参数**：
- period: 光栅周期（像素）
- angle: 旋转角度（°）

### 5. 🌀 涡旋光束 (Vortex Beam)

**参考**: `vortex.m`

产生轨道角动量光束，形成螺旋相位。

**参数**：
- lnumber: 拓扑荷数（可为负）

### 6. 🎲 随机散斑 (Random Image)

**参考**: `randomimage.m`

随机相位图，用于散射光场。

**参数**：
- seed: 随机种子（可选，用于可重复）

### 7. ⬛ 分屏图案 (Divide Screen)

**参考**: `divide.m`

左右半屏不同灰度，用于测试和标定。

**参数**：
- grayvalue1: 左侧灰度值（0-255）
- grayvalue2: 右侧灰度值（0-255）

### 8. 🔮 CGH Simulation

**参考**: `GScode.m`

计算机生成全息图，包含GS和OC算法。

**功能**：
- 目标图像上传
- 迭代次数设置
- 光斑形状选择（Gaussian/Flat-circle/Flat-square）
- 光斑尺寸设置
- 算法选择（GS/OC）
- 再生图像预览
- **高斯光斑转换**：将点状光斑转换为高斯分布，使远场再现时呈现平滑光斑

**高斯光斑转换**：
- 检测目标图像中的光斑位置
- 将每个光斑替换为指定半径的高斯分布
- 避免远场再现时出现硬边点阵
- 可自定义高斯半径（建议 5-20 像素）

### 9. 🖼️ BMP 转换器

**新增功能**

将任意格式图像（PNG/JPG/TIFF/BMP 等）转换为 SLM 官方软件兼容的 **8-bit 灰度 BMP**，避免 `This image is a wrong type. Please input an 8-bit BMP image` 报错。

**功能**：
- 拖拽/点击上传任意格式图像
- 自动转换为 8-bit 灰度
- 自定义输出分辨率
- 保持原始尺寸选项
- 一键下载真实 BMP 文件

### 10. ▶️ 序列播放控制

- 将多个图案添加到序列
- 播放/暂停/停止控制
- 可调播放间隔
- 循环播放支持

### 10. 🔌 设备连接管理

- 模拟SLM设备连接
- 实时连接状态显示
- 一键发送图案到SLM

---

## 📁 项目结构

```
web_app/
├── app.py                          # Flask后端应用
├── requirements.txt                # Python依赖
├── start.bat / start.sh            # 启动脚本
├── test_modules.py                 # 自动化测试脚本
├── PLAN.md                         # 项目集成计划
├── README.md                       # 项目文档（本文档）
├── USER_GUIDE.md                   # 用户使用指南
├── PRO_GUIDE.md                    # 专业版详细指南
├── PROJECT_COMPLETE.md             # 项目完成报告
├── fresnel_config.db               # SQLite数据库（自动生成）
├── output_phase_patterns/          # 输出目录（自动生成）
│
├── templates/
│   └── index_pro.html              # 专业版主页面（唯一界面）
│
├── static/
│   ├── css/
│   │   └── pro_style.css           # 专业版样式
│   └── js/
│       └── pro_main.js             # 专业版交互逻辑
│
└── matlab_SLM_功能模块参考代码/      # 原始MATLAB参考代码
    └── SLM常见相位图的生成源代码/
```

---

## 🔬 API接口

### 生成SLM常见相位图

```
POST /api/generate/<pattern_type>
```

支持的 `pattern_type`：
- `fresnel` - 菲涅尔透镜
- `fresnel_three_spots` - 水平等间距三点聚焦菲涅尔相位图
- `axicon` - 轴棱锥透镜
- `blaze` - 闪耀光栅
- `sine` - 正弦光栅
- `vortex` - 涡旋光束
- `random` - 随机散斑
- `divide` - 分屏图案

### CGH计算

```
POST /api/cgh/calculate
```

参数：
- `target_image`: 目标图像 Base64
- `algorithm`: `gs` 或 `oc`
- `light_shape`: `gaussian` / `flat-circle` / `flat-square`
- `light_size`: 光斑尺寸（mm）
- `iterations`: 迭代次数
- `width`, `height`: 输出分辨率
- `gaussian_spots`: 是否将点状光斑转为高斯分布（可选，默认 false）
- `spot_radius`: 高斯光斑半径（像素，可选，默认 10）

### BMP 格式转换

```
POST /api/convert-to-bmp
```

参数：
- `image`: 输入图像 Base64 字符串
- `width` (可选): 输出宽度
- `height` (可选): 输出高度
- `grayscale` (可选): 是否转灰度，默认 true

### 其他接口

```
GET    /api/presets          # 获取所有预设
POST   /api/presets          # 保存预设
DELETE /api/presets/<id>     # 删除预设
GET    /api/history          # 获取生成历史
GET    /api/download/<filename>  # 下载文件
```

---

## 🧪 测试

运行自动化测试脚本：

```bash
cd web_app
python test_modules.py
```

测试结果：
```
fresnel          ✅ 通过
axicon           ✅ 通过
blaze            ✅ 通过
sine             ✅ 通过
vortex           ✅ 通过
random           ✅ 通过
divide           ✅ 通过
cgh_gs           ✅ 通过
cgh_oc           ✅ 通过
cgh_gaussian_spots ✅ 通过
cgh_oc_gaussian  ✅ 通过
convert_rgb_png  ✅ 通过
convert_rgba_png ✅ 通过
convert_jpeg     ✅ 通过
convert_slm_size ✅ 通过

总计: 15/15 通过
🎉 所有模块测试通过！
```

---

## 📝 版本历史

### v3.2 Gaussian Spots Edition (2026-07-29)
- ✅ 新增 CGH 高斯光斑转换功能
- ✅ 新增 `gaussian_spots` 和 `spot_radius` API 参数
- ✅ 自动检测目标图像中的光斑并转换为高斯分布
- ✅ 前端 UI 新增高斯光斑转换选项
- ✅ 测试覆盖扩展至 15 个模块，全部通过

### v3.1 BMP Converter Edition (2026-07-29)
- ✅ 新增 BMP 转换器模块
- ✅ 新增 `/api/convert-to-bmp` 接口
- ✅ 支持 PNG/JPG/TIFF/BMP 等格式转 8-bit 灰度 BMP
- ✅ 修复下载时 PNG base64 伪装成 BMP 的问题
- ✅ 测试覆盖 13 个模块，全部通过

### v3.0 Full Modules Edition (2026-07-28)
- ✅ 集成所有MATLAB参考代码功能模块
- ✅ 新增轴棱锥、闪耀光栅、正弦光栅、涡旋光束、随机散斑、分屏图案
- ✅ 新增 `/api/generate/<pattern_type>` 统一接口
- ✅ 新增自动化测试脚本 test_modules.py
- ✅ 优化菲涅尔透镜算法以匹配MATLAB参考
- ✅ 移除基础版，仅保留专业版

### v2.0 CGH Edition (2026-07-28)
- ✅ 新增CGH Simulation模块
- ✅ 实现GS和OC相位恢复算法

### v2.0 Professional (2026-07-28)
- ✅ 新增专业版UI界面

### v1.0 Basic (2026-07-28)
- ✅ 基础相位图生成

---

**开发团队**: AI Assistant
**技术支持**: 基于LCOS-SLM空间光调制器技术
**最后更新**: 2026-07-28
