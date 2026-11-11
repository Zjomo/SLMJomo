# LCOS-SLM Web UI 交互点击测试方案 v2.0

> 更新日期：2026-09-05　|　对象：`web_app` Flask 单页专业控制台（`index_pro.html`）
> 本版在 v1 基础上补充：项目逻辑解析、具体元素定位符（选择器）、优先级分层的用例编号体系。

## 1. 项目逻辑解析（测试上下文）

### 1.1 系统定位

LCOS-SLM（空间光调制器）相位图生成与控制工作台：在浏览器内完成「选择图案类型 → 填参数 → 生成 8-bit 相位图 BMP → 预览/仿真验证 → 加入序列 → 模拟设备输出」的完整链路；真实 SLM 下发尚未接入。

### 1.2 技术栈与数据流

- 后端：Flask 单文件 `web_app/app.py`，核心类 `SLMPatternGenerator`（菲涅尔、双环、涡旋、光栅等 12 类算法 + CGH GS/OC 算法 + 傅里叶面仿真）。
- 数据库：SQLite（`instance/`），存生成历史与参数预设。
- 输出：`output_phase_patterns/` 下 BMP 文件；预览以 base64 回传前端。
- 前端：`templates/index_pro.html` 单页 + `static/js/pro_main.js`，全部交互为 onclick 驱动。

### 1.3 页面结构（16 个 section）

顶栏（设备状态 + 连接设备）｜左侧栏（快速导航 15 项 + 工作流按钮 + 最近使用）｜中央 15 个图案/工具模块卡片（默认展开：fresnel、double-ring、cgh-simulation；其余折叠）｜右侧预览栏｜底部序列面板。

### 1.4 后端 API 与 UI 模块对应

| UI 模块 | section id | 生成函数（onclick） | API |
|---|---|---|---|
| 菲涅尔透镜 | `fresnel` | `generateFresnel()` | `POST /api/generate` |
| 三点聚焦 | `fresnel-three-spots` | `generatePattern('fresnel_three_spots')` | `POST /api/generate/fresnel_three_spots` |
| 三点聚焦（无透镜） | `three-spots-no-lens` | `generatePattern('three_spots')` | `POST /api/generate/three_spots` |
| 内外圈复合光斑 | `double-ring` | `generateDoubleRing()` | `POST /api/generate/double_ring` |
| 轴棱锥透镜 | `axicon` | `generatePattern('axicon')` | `POST /api/generate/axicon` |
| 柱面透镜 | `cylindrical` | `generatePattern('cylindrical')` | `POST /api/generate/cylindrical` |
| 闪耀光栅 | `blaze` | `generatePattern('blaze')` | `POST /api/generate/blaze` |
| 正弦光栅 | `sine` | `generatePattern('sine')` | `POST /api/generate/sine` |
| 涡旋光束 | `vortex` | `generatePattern('vortex')` | `POST /api/generate/vortex` |
| 随机散斑 | `random` | `generatePattern('random')` | `POST /api/generate/random` |
| 分屏图案 | `divide` | `generatePattern('divide')` | `POST /api/generate/divide` |
| 十字测试图 | `cross` | `generatePattern('cross')` | `POST /api/generate/cross` |
| CGH Simulation | `cgh-simulation` | CGH 表单 | `POST /api/cgh/calculate` |
| BMP 转换器 | `bmp-converter` | `convertToBmp()` | `POST /api/convert-to-bmp` |
| 傅里叶面模拟 | `fourier-sim` | `runFourierSimulation()` | `POST /api/simulate/fourier` |

辅助 API：`GET/POST/DELETE /api/presets`（预设）、`GET /api/history`（历史）、`GET /api/download/<filename>`（下载）。

## 2. 关键 UI 定位符速查（自动化执行依据）

### 2.1 全局导航与设备

| 元素 | 选择器 | 点击行为 |
|---|---|---|
| 顶部菜单 | `.menu-item` | 首页 / 图案库到 `#fresnel`，序列到 `#sequence-panel`，绘图板到 `#paint-board`；校正 / 设置保持禁用并提示未实现 |
| 左侧导航项（15 项） | `li[onclick="scrollToSection('<section-id>')"]` | 滚动到模块并高亮 |
| 模块折叠/展开 | `#<section-id> button[onclick="toggleModule('<section-id>')"]` | 切换 `.collapsed` |
| 模块重置 | `button[onclick="resetModule('<section-id>')"]` | 恢复默认参数 |
| 连接设备 | `button[onclick='connectDevice()']` | 模拟连接（前端状态） |
| 显示到 SLM | `button[onclick='showOnSLM()']` | 模拟发送 |
| 工作流按钮 | `button[onclick="startWorkflow('new|open|save')"]` | 新建确认；JSON 项目保存/打开 |

顶部菜单回归：依次点击首页、图案库、序列和绘图板，目标区块应滚入中央工作区且对应菜单高亮；校正和设置应保持不高亮并显示“尚未实现”提示。

### 2.2 菲涅尔透镜（默认展开，核心路径）

| 元素 | 选择器 | 说明 |
|---|---|---|
| 焦距输入/滑块 | `#focus_mm` / `#focus_slider` | 100–98000 mm，联动 |
| 波长输入 | `#wavelength_nm` | 355–1064 nm |
| 波长预设按钮 | `button[data-wl='473|532|633|1064']` | 同步输入框并高亮 |
| 像素间距 | `#pitch_mode` | 12.5/20 μm |
| 生成 | `button[onclick='generateFresnel()']` | 调 `/api/generate` |
| 相位图预览 | `#phase_image` | base64 图 |
| 加入序列 | `button[onclick='addToSequence()']` | 写入序列面板 |
| 下载 | `#fresnel_download_btn` | 生成前 disabled |

### 2.3 涡旋/散斑等通用模块

- 拓扑荷：`#vortex_lnumber`；散斑种子：`#random_seed`；尺寸：`#<type>_width/#<type>_height`
- 生成：`section 内 button[onclick="generatePattern('<type>')"]`
- 加入序列 / 显示到 SLM：`button[onclick='addCurrentToSequence()']` / `button[onclick='showCurrentOnSLM()']`
- 下载：`#<type>_download_btn`

### 2.4 双环复合光斑

`#double_ring_inner_radius`、`#double_ring_outer_radius`、`#double_ring_iterations`（GS 迭代）、`#double_ring_width/height`；生成按钮 `generateDoubleRing()`；目标/相位/重建三图更新。

### 2.5 BMP 转换器

| 元素 | 选择器 |
|---|---|
| 文件 input | `#converter_input_image` |
| 输入预览/信息 | `#converter_preview_img` / `#converter_input_info` |
| 输出宽/高 | `#converter_width` / `#converter_height` |
| 保持原始尺寸 | `#converter_keep_size` |
| 灰度选择 | `#converter_grayscale` |
| 转换/下载 | `convertToBmp()` 按钮 / `#converter_download_btn` |
| 输出预览 | `#converter_output_img` |

### 2.6 傅里叶面模拟

`#fourier_illumination_type`（uniform/gaussian，联动 `#fourier_beam_radius_container` 显隐）、`#fourier_width/height`、`#fourier_colormap`、输入源按钮 `useCurrentPhaseForFourier()` / `#fourier_upload_input`、执行 `runFourierSimulation()`、四张结果图 `#fourier_color_img/#fourier_log_img/#fourier_raw_img/#fourier_illumination_img`、下载 `#fourier_download_btn`。

### 2.7 序列面板与预览栏

播放/暂停/停止：`#play_btn` / `#pause_btn` / 停止按钮；序列列表 `#sequence_list`；间隔 `#play_interval`；循环 `#loop_play`。预览工具：`zoomIn()/zoomOut()/resetZoom()`。

## 3. 分层用例体系（P0 核心路径 → P1 模块覆盖 → P2 异常边界）

### P0 核心路径（每次回归必跑，对应演示视频脚本）

| ID | 步骤（点击序列） | 预期 |
|---|---|---|
| P0-1 | 打开 `/` | 200；顶部状态栏、侧栏 15 项导航、fresnel/double-ring/cgh 默认展开可见；console 无 error |
| P0-2 | 点 `button[data-wl='633']` → `#focus_mm` 填 800 → `#x_pixels/#y_pixels` 填 512 → 点生成 | 请求 success；`#phase_image` 显示 base64；下载按钮启用；历史+1；参数摘要更新 |
| P0-3 | 点 `addToSequence()` | `#sequence_list` 新增条目（含模块名与参数摘要） |
| P0-4 | 导航至 vortex → 展开模块 → `#vortex_lnumber` 填 2 → 尺寸 256 → 生成 → 加入序列 | 相位图更新；序列第 2 条出现 |
| P0-5 | `#play_interval` 填 300 → 播放 → 暂停 → 停止 | 播放时 pause_btn 启用；暂停保留索引；停止后恢复初始按钮态 |
| P0-6 | BMP：`#converter_input_image` 上传 JPG → 尺寸 512x512 → 灰度"是" → 转换 | `#converter_output_img` 显示；`#converter_download_btn` 启用；服务端产出 8-bit BMP |
| P0-7 | Fourier：`useCurrentPhaseForFourier()` → 照明选 gaussian（半径输入框出现）→ 256x256 → 开始模拟 | 四张结果图有 src；色图标签与选择一致；`#fourier_download_btn` 启用 |
| P0-8 | 点 `connectDevice()` → `showOnSLM()` | 状态变"已连接" + 成功提示（标注：前端模拟路径） |

### P1 模块覆盖（每模块至少 1 条正常路径）

| ID | 模块 | 关键断言 |
|---|---|---|
| P1-01 | fresnel_three_spots | 生成返回 base64；预览更新 |
| P1-02 | three_spots | 同上 |
| P1-03 | double-ring | 页面自动生成后目标图、相位图、重建图三张均有图像且可见；手动生成后下载按钮启用 |
| P1-04 | axicon | 生成成功，预览为环形结构 |
| P1-05 | cylindrical | 生成成功；诊断值渲染（标注"非实测"） |
| P1-06 | blaze / sine | 周期 16：条纹方向符合参数 |
| P1-07 | random | 固定 seed=42 两次生成结果一致（可复现） |
| P1-08 | divide / cross | 生成成功，预览切换 |
| P1-09 | cgh-simulation | 上传目标图并计算 CGH；CGH 相位图、重建图和光斑图出现（隔离浏览器回归以 64×64、1 次迭代验证端到端流程） |
| P1-10 | presets | 保存预设 → 应用后参数回填 → 删除成功 |
| P1-11 | 历史面板 | `GET /api/history` 安全渲染；点击后加载已保存相位图并恢复有效参数快照；无快照的旧记录只加载图像 |
| P1-12 | 预览工具 | zoomIn/Out/reset 后 `#phase_image` transform 变化（隔离浏览器回归覆盖） |
| P1-13 | 项目文件 | 修改参数、上传图像、序列和 CGH → 保存 JSON → 清空或替换页面状态 → 打开 JSON → 参数、自定义光斑、上传图、序列、主预览及 CGH 目标/结果预览恢复（隔离浏览器回归覆盖） |

### P2 异常与边界

| ID | 操作 | 预期 |
|---|---|---|
| P2-01 | 焦距/波长填 0 后生成 | 拒绝或错误提示，无伪成功 |
| P2-02 | vortex 拓扑荷填 -50 / 51 | 前端 min/max 拦截或后端 4xx |
| P2-03 | BMP 未上传直接转换 | "请先上传"提示，无空请求 |
| P2-04 | CGH 迭代为空/负数 | 阻止请求或错误提示，页面不卡死 |
| P2-05 | 序列间隔 100ms（最小值）+ 循环勾选 | 循环播放多帧后可以停止；播放间隔被清除、索引归零且按钮恢复（隔离浏览器回归覆盖） |
| P2-06 | 未连接时点"显示到 SLM" | "请先连接"提示 |
| P2-07 | 390px 视口 | `document.documentElement.scrollWidth <= 390`，无横向溢出（当前 Chromium 回归通过） |
| P2-08 | 同一任务进行时快速触发生成 3 次 | 仅发出一个生成请求；并发锁和 loading 状态在完成后释放（隔离浏览器回归覆盖） |
| P2-09 | 全程监听 console/network | 0 console/page error、请求失败或 HTTP 错误响应（隔离浏览器回归覆盖） |

## 4. 执行方式

1. **隔离浏览器回归**：先安装 `requirements-test.txt` 和 Playwright Chromium，再运行 `python browser_workflow_test.py`。脚本自行启动临时 SQLite、临时输出目录和随机本地端口，覆盖预设、生成/历史、预览缩放、BMP 转换、Fourier、CGH、项目完整往返、自定义光斑阵列、循环序列停止、快速重复提交、390px 布局、双环预览和 console/page/network 错误。
2. **P0 演示录制**：运行 `python ui_demo_v2.py`（Playwright Chromium headless，1280×800）。脚本也会自行启动隔离服务；截图、WebM 视频和 JSON 结果写入一个临时输出目录，并在结果中打印目录路径。
3. **视频产物**：WebM 可用 ffmpeg 转码为 H.264 MP4。
4. **人工补充**：P1/P2 用例按第 2 节选择器速查表补充验证。
5. **模块级 API 回归**：`python test_modules.py`。脚本自行启动隔离服务，使用临时数据库、输出目录和随机端口；BMP 转换会验证新生成文件的格式、灰度模式与尺寸。

## 5. 通过标准与已知边界

- P0 全部通过 + console 0 error + 关键 API 2xx → 本次演示视频可作为"核心链路健康"证据。
- 能力边界（不可宣称项）：设备连接与显示到 SLM 为前端模拟；缺少参数快照的旧历史记录只能加载图像；Fourier/双环重建为数值仿真，非实测光斑；真实 USB/SDK 发送需实机验证。
- 回归状态：390px 横向溢出和双环相位图 hidden 状态是 v1 发现的问题；当前隔离 Chromium 回归通过这两项检查。

## 6. 产物与清理

- `browser_workflow_test.py` 使用系统临时目录并在结束时清理，不在仓库留下测试数据库或输出文件。
- `ui_demo_v2.py` 将演示产物写到系统临时目录；根据其输出的 `output_dir` 路径查看或清理。
- 旧版脚本 `ui_demo_quick.py` / `ui_demo_record.py` 与 `artifacts/ui_demo*/` 保留作历史证据。
