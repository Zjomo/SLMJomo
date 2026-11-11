# UI 点击测试执行报告

## 执行信息

- 地址：`http://127.0.0.1:5000/`
- 页面：`index_pro.html` 单页 LCOS-SLM 专业控制台
- 浏览器：本地 Playwright Chromium（headless，1280×800）
- 演示脚本：`ui_demo_v2.py`（对应 `UI_CLICK_TEST_PLAN.md` v2.0 的 P0 核心路径）
- 执行日期：2026-09-05

## v2 结果摘要

| 项目 | 结果 |
|---|---|
| P0 核心路径 | **33/33 步全部通过** |
| 控制台错误 | 0 条 |
| 失败请求 | 0 条 |
| 覆盖模块 | 菲涅尔透镜、涡旋光束、序列播放、BMP 转换器、傅里叶面模拟、设备连接（模拟） |
| 演示视频 | `artifacts/ui_demo_v2/SLMJomo_UI_Demo_v2.mp4`（H.264，19.3 秒，约 1 MB，1280×800） |

### P0 分步结果

| 路径 | 步骤 | 结果 |
|---|---|---|
| P0-1 首页加载 | networkidle + 双环自动预览沉降 | 通过 |
| P0-2 菲涅尔生成 | 633nm 预设 → f=800 → 512×512 → 生成 → 预览断言 | 通过 |
| P0-3 加入序列 | `addToSequence()` | 通过 |
| P0-4 涡旋生成 | 展开模块 → l=2 → 256×256 → 生成（以下载按钮启用为断言） → 加入序列 | 通过 |
| P0-5 序列控制 | 断言 2 条目 → 800ms 间隔 → 播放（等待首个 tick 翻转按钮态）→ 暂停 → 停止 | 通过 |
| P0-6 BMP 转换 | 上传 JPG → 512×512 → 灰度转换 → 输出预览断言 | 通过 |
| P0-7 傅里叶仿真 | 使用当前相位图 → 高斯照明 → 256×256 → 模拟 → 彩色强度图断言 | 通过 |
| P0-8 设备（模拟） | 连接设备 → 显示到 SLM | 通过 |

## 本轮发现（相对 v1 的新增结论）

1. **序列播放时序语义**：`playSequence()` 会同步显示首帧并启用暂停按钮，然后才创建 interval（[pro_main.js L899-L938](file:///f:/0_My_jupyter/2_Optics/SLMJomo/SLMJomo/web_app/static/js/pro_main.js#L899-L938)）；序列播完会自动调用 `stopSequence()`。自动化可在点击后立即断言暂停按钮已启用，且暂停必须在播完前点击。
2. **页面加载自动触发双环预览请求**：init 时约 350ms 后自动 `POST /api/generate/double_ring`（[pro_main.js L114](file:///f:/0_My_jupyter/2_Optics/SLMJomo/SLMJomo/web_app/static/js/pro_main.js#L114)）。首轮录制中该请求曾出现一次 `ERR_CONNECTION_RESET`（与演示操作撞车）。v2 脚本已通过加载后等待 1.5s 规避，本轮 0 失败请求。建议关注该自动请求对首屏负载的影响。
3. **序列面板无侧栏导航入口**：`scrollToSection('sequence-panel')` 无对应 li，自动化需直接对 `#sequence-panel` 执行 `scroll_into_view_if_needed`（方案文档已同步）。
4. v1 报告过 390px 横向溢出；当前隔离浏览器回归在 390px 视口确认无横向溢出（P2-07），并断言双环目标/相位/重建三图在自动生成后均可见（P1-03）。

## 交付物（v2）

- `UI_CLICK_TEST_PLAN.md`：v2.0 测试方案（项目逻辑解析 + 元素定位符速查 + P0/P1/P2 分层用例）。
- `ui_demo_v2.py`：P0 核心路径录制脚本（可重复执行，退出码即判定结果）。
- `artifacts/ui_demo_v2/SLMJomo_UI_Demo_v2.mp4`：**演示视频（19.3 秒）**。
- `artifacts/ui_demo_v2/01_home.png` ~ `09_device_state.png`：9 张关键步骤截图。
- `artifacts/ui_demo_v2/ui_demo_v2_results.json`：分步执行结果、控制台与网络监控。
- `artifacts/ui_demo_v2/video/*.webm`：原始录制（转码前）。

## 交付物（v1，历史证据）

- `ui_demo_quick.py` / `ui_demo_record.py`：旧版录制脚本。
- `artifacts/ui_demo_quick/`：旧版截图、`SLMJomo_UI_demo.mp4`（约 2 秒）、22 项模块测试输出。
- `artifacts/ui_demo/`：扩展版录制证据。

## 通过判定

P0 全部通过 + 0 控制台错误 + 0 失败请求 → **核心链路健康**。演示视频可作为交互流程演示与回归基线使用。
当前能力边界：设备连接/显示仍为前端模拟路径；缺少参数快照的旧历史条目只能加载相位图；Fourier/双环结果为数值仿真；真实 USB/SDK 发送需实机验证。项目文件和历史快照功能已由后续回归覆盖。

## 2026-11-11 增量验证

- 浏览器往返验证通过：保存并打开项目 JSON 后，工作区参数、二维自定义光斑阵列和播放序列恢复；导入序列文本作为纯文本渲染。
- 浏览器验证通过：保存、应用和删除菲涅尔参数预设。
- `python -B -m unittest test_fresnel_spot_array test_fresnel_three_spots test_app_routes -v`：26 项通过，覆盖自定义光斑阵列、预设 CRUD、历史记录元数据、生成边界和下载路径越界拒绝。
- `node test_project_image_headers.cjs`：18 项通过，覆盖 PNG、JPEG、BMP、GIF、WebP、小端/大端 TIFF 的 LONG/SHORT 尺寸字段、JPEG 旋转尺寸匹配和无效数据。
- `node test_cgh_handoff.cjs`：4 项通过，覆盖 CGH 目标图导入、最新 CGH 相位图恢复和空状态提示。
- `node test_spot_array_project_validation.cjs`：5 项通过，确认项目光斑阵列使用待导入参数预检，失败时不改动当前控件/阵列状态。
- `node --check static/js/project_image_utils.js`、`node --check static/js/pro_main.js` 与 `node --check static/js/spot_array.js`：通过。
- 该阶段续审未能连接本地浏览器调试端点；后续隔离浏览器回归见下节。

## 2026-11-11 隔离浏览器回归

- python browser_workflow_test.py：通过。脚本启动随机 localhost 端口，使用临时 SQLite 数据库和临时生成目录，执行后自动清理。
- 浏览器路径：创建/应用/删除预设；生成菲涅尔相位图并从历史记录恢复图像和参数；保存并重新打开项目 JSON；编辑自定义光斑阵列并确认阵列与强度恢复。
- 390px 视口检查：文档宽度不超过 390px，无横向滚动溢出。
- Playwright Chromium headless，1280×900；浏览器控制台错误 0 条。
- python -B -m unittest discover -s . -p test_*.py -v：29 项通过。
- Node 回归：18 个图像头检查、项目 v1/v2 往返、历史参数恢复、5 个光斑阵列校验、4 个 CGH handoff 和 6 个导航检查均通过；三份前端脚本 node --check 通过。
- 测试启动器在建表前断言实际 SQLite 路径和输出目录均位于临时目录内；本次未使用默认用户数据库。
- 同一套 Python 和 Playwright 回归又在干净临时虚拟环境中通过，解析目标为 Windows x64 / CPython 3.12。

## 2026-11-11 P0 演示回归

- python -B ui_demo_v2.py：33/33 步通过，覆盖首页、菲涅尔生成、序列播放、涡旋图生成、BMP 转换、傅里叶模拟和模拟设备控制。
- Chromium 控制台错误 0 条、失败请求 0 条；服务使用随机本地端口、临时 SQLite 和临时输出目录。
