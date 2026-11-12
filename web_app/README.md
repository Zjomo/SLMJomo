# 🔮 LCOS-SLM 专业控制面板 v3.0

## 🎯 项目概述

这是一个基于 **Flask + JavaScript + SQLite** 的LCOS-SLM专业控制Web应用，集成了多种SLM相位图生成和 **CGH Simulation（计算机生成全息图模拟）**。当前设备连接与发送界面为模拟状态，不会通过厂商SDK驱动真实SLM。

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

# Linux/macOS
sh start.sh

# 或手动启动
python app.py
```

For the dependency versions tested on Windows x64 with CPython 3.12, install `requirements-win-py312-x64.lock` instead of the open-range `requirements.txt`. Linux/macOS installations use `requirements.txt`; that platform matrix has not yet been verified in a clean environment.

For an existing database created before history parameter snapshots were added, stop the app and run `python migrate_history_schema.py` once before starting it again. The command creates a timestamped SQLite backup beside the database, then adds the nullable history column. New databases do not need this migration.

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
- **视频序列播放**：多张目标图批量计算为 CGH 相位图序列，按帧连续播放形成动态全息视频

**高斯光斑转换**：
- 检测目标图像中的光斑位置
- 将每个光斑替换为指定半径的高斯分布
- 避免远场再现时出现硬边点阵
- 可自定义高斯半径（建议 5-20 像素）

**视频序列播放（v3.4 新增）**：
- **帧收集**：多选导入目标图像，或将当前 CGH 计算结果追加为一帧（最多 200 帧）
- **帧管理**：缩略图列表支持上移/下移排序、单帧删除、一键清空、点击跳帧
- **批量计算**：按当前 CGH 参数（算法/光斑形状/迭代次数/分辨率）逐帧计算，带进度提示
- **视频播放**：播放/暂停/停止、帧间隔 100~10000 ms、循环播放、进度滑块跳帧、帧计数指示
- **显示模式**：播放器可切换"相位图 / 再建图"，相位模式下同步主预览
- **序列导出**：多帧相位图打包为 ZIP（按序命名的 8-bit BMP），可用于 SLM 软件的连续播放/电影模式
- **项目持久化**：帧序列随 `.slmproject.json` 保存与恢复

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

### 11. 🎬 傅里叶面序列视频播放 (Fourier Video)

在"傅里叶面强度模拟"模块中新增，将多张相位图组成序列并模拟出"视频播放"效果：

- **序列帧管理**：一键添加当前相位图，或多选批量上传相位图作为帧（单次最多 60 帧），支持缩略图列表、单帧删除与清空；每帧提供 ▲/▼ 按钮手动调整播放顺序，排序后模拟结果自动同步重排
- **批量模拟**：按当前照明/输出参数一次模拟全部帧的傅里叶面强度，并返回每帧平均/峰值强度统计；模拟完成后模块中的"彩色强度分布"、"对数强度分布"、"原始强度分布"面板同步显示序列帧结果，可通过帧选择器切换查看任意帧
- **视频播放**：支持"傅里叶面强度序列"（伪彩色远场动画）与"相位图序列"（原始帧动画）两种播放内容，播放/暂停/停止、帧间隔可调（50~5000 ms）、循环播放
- **GIF 导出**：服务器端按当前参数重新模拟并导出动画 GIF（帧时长 20~2000 ms 自动钳位）

### 项目工作流与参数预设

- 侧栏可新建、打开或保存 `.slmproject.json` 项目文件，文件最大 32 MB
- 项目保存工作区参数、菲涅尔输入图、二维自定义光斑阵列和播放序列，包括绘图板动画片段、CGH 目标和生成预览
- 相同的 CGH 相位图与主预览图只在项目文件中保存一次
- 历史记录可恢复相位图和已保存的参数快照；遗留记录仍可加载相位图，输入图像数据不会重复写入历史表
- 菲涅尔模块的保存按钮可创建参数预设，并在侧栏列表中应用或删除

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
- `double_ring` - 基于 `SLM_TEST.m` 的内圈高斯 + 外圈边缘反高斯复合光斑；返回 SLM 相位图、目标光强和重建光强预览

`double_ring` 参数：`inner_radius`、`outer_radius`（像素半径），`inner_width`/`w_in`、`outer_width`/`w_out`（高斯宽度），`inner_intensity`、`outer_intensity`、`between_intensity`（0-1 光强），`iterations`（GS 迭代次数），以及 `width`、`height`。默认值对应 `SLM_TEST.m`：`R_max=50`、`w_in=8`、`w_out=10`、`I_outer=1`、`I_inner=0.7`、`I_flat=0.2`、`iterations=100`。实时预览请求可附带 `preview: true`，仅返回内存图像，不写入 BMP 或历史记录。

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

### CGH 视频序列导出

```
POST /api/cgh/sequence/export
```

参数：
- `frames`: 相位图 Base64 列表（1~200 帧，必填）
- `prefix`: ZIP 内文件名前缀（可选，默认 `cgh`，自动去除非法字符）

响应：8-bit 灰度 BMP 序列打包的 ZIP 文件（`frame_001.bmp` 起按序命名），直接触发下载。

### BMP 格式转换

```
POST /api/convert-to-bmp
```

参数：
- `image`: 输入图像 Base64 字符串
- `width` (可选): 输出宽度
- `height` (可选): 输出高度
- `grayscale` (可选): 是否转灰度，默认 true

### 傅里叶面序列（视频）模拟

```
POST /api/simulate/fourier/sequence
```

参数：
- `phase_images`: 相位图 base64 列表（必填，1~60 帧）
- `illumination_type` / `beam_radius` / `width` / `height` / `colormap`: 与单帧模拟相同

返回：`frames` 数组，每帧包含 `intensity_color`、`intensity_log`、`intensity_raw` 三张图与 `mean_intensity`、`peak_intensity` 统计。

### 傅里叶面序列 GIF 导出

```
POST /api/simulate/fourier/export-gif
```

参数：同上，另加：
- `frame_duration_ms`: 每帧时长（毫秒，默认 200，范围 20~2000）
- `intensity_mode`: `color` 或 `log`（默认 `color`）

返回 `image/gif` 动画文件（无限循环）。

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

在 `web_app` 目录运行 Python 测试和 JavaScript 回归检查：

```bash
python -m unittest discover -s . -p "test_*.py" -v
node --check static/js/pro_main.js
node test_project_image_headers.cjs
node test_project_roundtrip.cjs
node test_history_restore.cjs
node test_spot_array_project_validation.cjs
node test_cgh_handoff.cjs
node test_cgh_video.cjs
node test_top_navigation.cjs
```

The history schema migration and backup tests use temporary SQLite files. They do not access the configured user database.

To run the isolated browser regression, install the test dependencies and Chromium once, then run the script from this directory:

```bash
python -m pip install -r requirements-test.txt
python -m playwright install chromium
python browser_workflow_test.py
```

On the tested Windows x64 / CPython 3.12 target, use `requirements-win-py312-x64-test.lock` instead of `requirements-test.txt` for pinned runtime and browser-test packages.

The browser test starts Flask on an ephemeral localhost port and asserts that its SQLite database and generated files resolve inside a temporary directory before creating tables or handling requests. It covers preset create/apply/delete, Fresnel generation and history restore, project save/open, and custom spot-array editing and persistence. It does not require the regular Web App server to be running.

---

## 📝 版本历史

### v3.5 CGH Video Sequence Edition (2026-11-11)
- ✅ CGH Simulation 新增"视频序列播放"功能：多相位图序列连续播放实现动态全息视频
- ✅ 支持多选导入目标图 + 加入当前 CGH，缩略图帧列表管理（排序/删除/清空/跳帧）
- ✅ 批量按当前 CGH 参数逐帧计算，带进度与失败统计
- ✅ 播放器支持播放/暂停/停止、帧间隔、循环、进度滑块、相位图/再建图显示切换
- ✅ 新增 `POST /api/cgh/sequence/export`：多帧相位图导出为 8-bit BMP 序列 ZIP
- ✅ 帧序列支持 `.slmproject.json` 项目保存/恢复（≤200 帧）
- ✅ 新增 `test_cgh_sequence.py`（13 项后端测试）与 `test_cgh_video.cjs`（前端 vm 回归）

### v3.5 Fourier Sequence Sync Edition (2026-11-11)
- ✅ 序列帧列表每帧新增 ▲/▼ 顺序调整按钮，支持手动排序；批量模拟结果随排序自动同步重排
- ✅ 点击"批量模拟序列"后，模块中的"彩色强度分布"、"对数强度分布"、"原始强度分布"面板同步显示序列帧结果
- ✅ 新增"分布面板显示序列帧"选择器，可在三个分布面板间切换浏览任意帧
- ✅ 项目恢复兼容暂态空 select：修复动态帧选择器导致"项目打开失败: 参数不受支持"的问题
- ✅ 单帧模拟结果与序列模拟结果一致性契约测试 + 浏览器端到端回归（上传/排序/同步/切帧）

### v3.4 Fourier Video Edition (2026-11-11)
- ✅ 傅里叶面模拟新增序列视频播放：多帧相位图批量模拟后按帧播放远场强度动画
- ✅ 新增 `/api/simulate/fourier/sequence` 批量序列模拟接口（单次最多 60 帧）
- ✅ 新增 `/api/simulate/fourier/export-gif` 动画 GIF 导出接口
- ✅ 支持"傅里叶面强度"与"相位图"两种播放内容，帧间隔与循环可调
- ✅ 新增 test_fourier_sequence.py 覆盖批量模拟、GIF 导出与异常分支

### v3.3 Double-ring Beam Edition (2026-09-02)
- 新增内圈高斯 + 外圈反高斯复合光斑相位图
- 支持内外圈半径、圆心光强和环间光强调节
- 新增前端即时目标光强预览、GS 相位图和重建光强预览

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

## SLAM 三光斑独立运动

专业版新增显微镜图像标定、三个材料/光斑分配、独立二维路径规划、逐帧相位生成、傅里叶重建预览及 CGH 视频序列交接。功能设计、参数解释、算法限制、项目保存策略和 USB_SLMControl 使用说明见 [SLAM 三光斑独立运动计划](../docs/slam-three-spot-motion-plan.md) 与 [专业版指南](PRO_GUIDE.md)。

默认输出位于 `output/Lingo/YYYYMMDD/<job-id>/`，可通过 `SLMJOMO_LINGO_OUTPUT_DIR` 覆盖。每项任务受 200 帧、估算总像素量和完成任务数量限制，ZIP 导出使用临时文件原子替换。USB 实时上传要求真实设备和 1272×1024 相位帧；软件测试未覆盖实体光学响应。
