# 📋 LCOS-SLM 功能模块集成计划

## 🎯 项目目标

参考 `matlab_SLM_功能模块参考代码` 中的所有MATLAB功能模块，将其全部补充到当前Web UI系统中，仅保留专业版界面，并对所有新增功能模块进行测试验证。

---

## 📚 参考模块清单

| 序号 | MATLAB文件 | 功能名称 | 当前状态 | 优先级 |
|:----:|:-----------|:---------|:--------:|:------:|
| 1 | fresnellens.m | 菲涅尔透镜 | ✅ 已实现 | 高 |
| 2 | axicon.m | 轴棱锥透镜 | ✅ 已实现 | 高 |
| 3 | blazegrating.m | 闪耀光栅 | ✅ 已实现 | 高 |
| 4 | sinegrating.m | 正弦光栅 | ✅ 已实现 | 高 |
| 5 | vortex.m | 涡旋光束 | ✅ 已实现 | 高 |
| 6 | randomimage.m | 随机散斑 | ✅ 已实现 | 中 |
| 7 | divide.m | 分屏图案 | ✅ 已实现 | 中 |
| 8 | GScode.m | GS算法CGH | ✅ 已实现（含 OC 算法） | 高 |

---

## 🏗️ 架构设计

### 后端架构 (app.py)

```
SLMPatternGenerator
├── fresnel_lens()         # 菲涅尔透镜
├── axicon_lens()          # 轴棱锥透镜
├── blaze_grating()        # 闪耀光栅
├── sine_grating()         # 正弦光栅
├── vortex_beam()          # 涡旋光束
├── random_image()         # 随机散斑
├── divide_screen()        # 分屏图案
└── cgh_gs()               # GS算法CGH

CGHSimulator
├── generate_light_shape()
├── gerchberg_saxton()
├── over_compensation()
└── calculate_cgh()
```

### API路由设计

```
POST /api/generate/fresnel       # 菲涅尔透镜
POST /api/generate/axicon        # 轴棱锥透镜
POST /api/generate/blaze         # 闪耀光栅
POST /api/generate/sine          # 正弦光栅
POST /api/generate/vortex        # 涡旋光束
POST /api/generate/random        # 随机散斑
POST /api/generate/divide        # 分屏图案
POST /api/cgh/calculate          # CGH计算（GS/OC）
```

### 前端架构

左侧导航栏包含所有模块：
- 🔍 菲涅尔透镜
- 🔺 轴棱锥透镜
- 🔷 闪耀光栅
- 📐 正弦光栅
- 🌀 涡旋光束
- 🎲 随机散斑
- ⬛ 分屏图案
- 🔮 CGH Simulation

---

## 📝 模块详细设计

### 1. 菲涅尔透镜 (fresnellens.m 参考)

**参数**：
- width: SLM宽度
- height: SLM高度
- focal_length: 焦距（mm）
- wavelength: 波长（nm）

**算法**：
```python
pixelsize = 25e-3 mm
R = 2 * abs(focal_length)
mirror(m,l) = R - sqrt(R^2 - ((l-width/2)^2 + (m-height/2)^2) * pixelsize^2)
mirror = max(mirror) - mirror
phase = mirror / wavelength * 2*pi
phase = mod(phase, 2*pi)
if focal_length > 0: phase = 255 - phase
```

### 2. 轴棱锥透镜 (axicon.m 参考)

**参数**：
- width, height: 分辨率
- radius: 相位周期半径（像素）

**算法**：
```python
phase = -sqrt((x-center_x)^2 + (y-center_y)^2) * 2*pi / radius
phase = mod(phase, 2*pi)
```

### 3. 闪耀光栅 (blazegrating.m 参考)

**参数**：
- width, height: 分辨率
- period: 周期（像素）
- angle: 旋转角度（°）

**算法**：
```python
phase = mod(round(cos(atan(y/x) - angle) * sqrt(x^2 + y^2)), period)
phase = phase * 255 * (period-1) / period / max
```

### 4. 正弦光栅 (sinegrating.m 参考)

**参数**：
- width, height: 分辨率
- period: 周期（像素）
- angle: 旋转角度（°）

**算法**：
```python
phase = 127.5 + 127.5 * sin(2*pi/period * cos(atan(y/x) - angle) * sqrt(x^2 + y^2))
```

### 5. 涡旋光束 (vortex.m 参考)

**参数**：
- width, height: 分辨率
- lnumber: 拓扑荷数

**算法**：
```python
# 计算象限角度
angle = atan2(y - center_y, x - center_x)
# 转换为0-2pi
phase = mod(angle * lnumber, 2*pi)
```

### 6. 随机散斑 (randomimage.m 参考)

**参数**：
- width, height: 分辨率
- seed: 随机种子（可选）

**算法**：
```python
phase = rand(height, width) * 255
```

### 7. 分屏图案 (divide.m 参考)

**参数**：
- width, height: 分辨率
- grayvalue1: 左侧灰度值（0-255）
- grayvalue2: 右侧灰度值（0-255）

**算法**：
```python
phase[:, :width/2] = grayvalue1
phase[:, width/2:] = grayvalue2
```

### 8. GS算法CGH (GScode.m 参考)

**算法**：
```python
# 读取目标振幅
C1 = abs(target)
# 初始化
C = target
for p in range(iterations):
    C = fftshift(C)
    D = ifft2(C)
    D = fftshift(D)
    D2 = angle(D)
    D = exp(1j * D2)  # 振幅替换为1
    D = fftshift(D)
    C = fft2(D)
    C = fftshift(C)
    C2 = angle(C)
    C = C1 * exp(1j * C2)

# 最终得到SLM相位
C = fftshift(C)
D = ifft2(C)
D = fftshift(D)
phase = angle(D)
phase = (phase + 2*pi) % (2*pi)  # 确保0-2pi
phase = phase * 128 / pi
```

---

## 🧪 测试计划

### 测试方法

每个模块测试以下方面：
1. **API响应**：接口返回正确JSON
2. **图像生成**：返回有效Base64图像
3. **参数边界**：测试最大/最小/异常参数
4. **UI交互**：滑块、按钮、预览正常
5. **文件保存**：输出文件正确保存

### 测试矩阵

| 模块 | API测试 | 图像测试 | 参数边界 | UI交互 | 文件保存 |
|------|:-------:|:--------:|:--------:|:------:|:--------:|
| 菲涅尔透镜 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 轴棱锥透镜 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 闪耀光栅 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 正弦光栅 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 涡旋光束 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 随机散斑 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 分屏图案 | ✅ | ✅ | ✅ | ✅ | ✅ |
| CGH GS | ✅ | ✅ | ✅ | ✅ | ✅ |
| CGH OC | ✅ | ✅ | ✅ | ✅ | ✅ |

### 测试用例

#### 菲涅尔透镜
- 输入：focal_length=1000, wavelength=532, 1272x1024
- 期望：返回同心圆环相位图
- 边界：focal_length=0 应报错或处理

#### 轴棱锥透镜
- 输入：radius=100, 1272x1024
- 期望：返回同心圆环（与菲涅尔不同）

#### 闪耀光栅
- 输入：period=50, angle=0, 1272x1024
- 期望：水平条纹
- 边界：angle=45 应旋转

#### 正弦光栅
- 输入：period=50, angle=0, 1272x1024
- 期望：正弦变化的条纹

#### 涡旋光束
- 输入：lnumber=1, 256x256
- 期望：单螺旋
- 边界：lnumber=5 应5个螺旋臂

#### 随机散斑
- 输入：seed=42, 256x256
- 期望：随机噪声图，可重复

#### 分屏图案
- 输入：grayvalue1=0, grayvalue2=255, 1272x1024
- 期望：左黑右白

#### CGH
- 输入：target_image, iterations=100, algorithm=gs
- 期望：返回CGH和再生图像

---

## 📅 实施步骤

### Phase 1: 后端实现 ✅
1. 创建 `SLMPatternGenerator` 类 ✅
2. 实现所有8个功能模块 ✅
3. 更新API路由 ✅
4. 统一输出格式和错误处理 ✅

### Phase 2: 前端UI实现 ✅
1. 更新左侧导航栏 ✅
2. 为每个模块创建参数面板 ✅
3. 添加交互控制按钮 ✅
4. 统一预览显示 ✅

### Phase 3: 前端交互逻辑 ✅
1. 为每个模块添加生成函数 ✅
2. 添加参数验证 ✅
3. 实现添加到序列功能 ✅
4. 实现下载和发送到SLM功能 ✅

### Phase 4: 样式优化 ✅
1. 为新增模块添加样式 ✅
2. 确保响应式布局 ✅
3. 优化用户体验 ✅

### Phase 5: 测试验证 ✅
1. 逐个模块测试API ✅
2. 测试UI交互 ✅
3. 修复bug ✅
4. 更新文档 ✅

---

## 🎨 UI设计规范

### 模块卡片布局
```
.module-card
├── .module-header
│   ├── 标题 + 图标
│   └── 操作按钮（折叠/重置/保存预设）
└── .module-content
    ├── .control-grid (2列)
    │   ├── .param-panel
    │   └── .param-panel
    └── .action-bar
        ├── 生成按钮
        ├── 添加到序列
        ├── 显示到SLM
        └── 下载按钮
```

### 参数控件
- 数值输入：`<input type="number">`
- 滑块：`<input type="range">`
- 下拉选择：`<select>`
- 快捷按钮：波长预设、光斑形状
- 文件上传：拖拽 + 点击

---

## 📊 预期输出

完成后的系统将具备：
- 8个SLM常见相位图生成功能
- 统一的Web UI界面
- 完整的API接口
- 实时预览和下载
- 序列播放控制
- 设备连接管理（模拟）

---

## 🚀 部署和访问

```bash
cd web_app
python app.py
```

访问：**http://127.0.0.1:5000/**

---

---

## 🆕 新增功能规划：PNG 转 8-bit BMP 转换器

### 需求背景

SLM 官方软件要求输入图像必须是 **8-bit BMP 灰度图**。用户常从 PNG/JPG 等格式导入时遇到报错：

> `This image is a wrong type. Please input an 8-bit BMP image.`

因此需要新增一个通用图像格式转换模块，自动将任意常见格式转换为符合官方要求的 8-bit BMP。

### 功能目标

1. 支持上传 PNG、JPG、JPEG、TIFF、BMP 等常见格式
2. 自动转换为 8-bit 灰度 BMP
3. 支持自定义输出分辨率
4. 支持图像预览
5. 提供一键下载

### 后端设计

新增接口：

```
POST /api/convert-to-bmp
```

请求参数：
- `image`: 输入图像 Base64 字符串
- `width` (可选): 输出宽度，默认原图宽度
- `height` (可选): 输出高度，默认原图高度
- `grayscale` (可选): 是否转换为灰度，默认 true

响应：
- `success`: 是否成功
- `image`: 转换后图像 Base64 预览
- `filename`: BMP 文件名
- `filepath`: 服务器保存路径
- `info`: 图像信息（尺寸、位深、模式）

### 前端设计

新增模块面板：`bmp-converter`

布局：
- 左侧：图像上传区（拖拽/点击）
- 中间：输出参数设置（宽度、高度、灰度选项）
- 右侧：预览与下载按钮

左侧导航栏新增：`🖼️ BMP 转换器`

### 测试计划

| 测试项 | 内容 | 期望结果 |
|--------|------|----------|
| PNG 转 BMP | 上传 24-bit PNG | 输出 8-bit 灰度 BMP |
| JPG 转 BMP | 上传彩色 JPG | 输出 8-bit 灰度 BMP |
| 带透明 PNG | 上传 RGBA PNG | 正确转换为灰度 |
| 自定义分辨率 | 指定 1272×1024 | 输出对应尺寸 BMP |
| 下载验证 | 下载输出文件 | 文件格式为 BMP，mode=L |

---

**计划制定时间**: 2026-07-28
**计划版本**: v2.0
**负责人**: AI Assistant