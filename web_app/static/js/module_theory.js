/**
 * 模块原理弹窗（Theory Modal）
 * ==============================
 * 为每个功能模块提供 "?" 按钮：点击弹出该模块的动态示意图 + 算法原理。
 * 按钮在页面加载时自动注入到每个有原理内容的 module-card 的 module-actions 区。
 * 动画均为纯 CSS（stroke 流动 / 旋转 / 脉冲），遵循 prefers-reduced-motion。
 */
(function () {
    'use strict';

    // ==================== SVG 公共部件 ====================
    const W = 720, H = 280;
    const svgOpen = (extra) =>
        `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" ${extra || ''}>`;
    const svgClose = () => '</svg>';

    // 平行入射光（3 条，含流动动画）
    function beamIn(x1, x2, ys, cls) {
        ys = ys || [110, 140, 170];
        return `<g class="${cls || 'th-neutral'}">` + ys.map(y =>
            `<line class="th-flow" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"></line>`
        ).join('') + `</g>`;
    }
    // 相位片面板
    function panel(x, y, w, h, stripes, cls) {
        let inner = '';
        const n = stripes || 5;
        for (let i = 1; i <= n; i++) {
            const sy = y + (h * i) / (n + 1);
            inner += `<line class="th-stripe" x1="${x + 6}" y1="${sy}" x2="${x + w - 6}" y2="${sy}"></line>`;
        }
        return `<rect class="${cls || 'th-panel'}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"></rect>${inner}`;
    }
    // 焦点亮斑
    function spot(cx, cy, r) {
        return `<circle class="th-spot th-pulse" cx="${cx}" cy="${cy}" r="${r || 8}"></circle>`;
    }
    // 短标签
    function lbl(x, y, text, anchor, cls) {
        return `<text class="${cls || 'th-label'}" x="${x}" y="${y}" text-anchor="${anchor || 'middle'}">${text}</text>`;
    }
    // 编号
    function step(x, y, text) {
        return `<text class="th-step" x="${x}" y="${y}" text-anchor="middle">${text}</text>`;
    }

    // ==================== 各模块原理内容 ====================
    const THEORY = {
        fresnel: {
            title: '菲涅尔透镜相位图',
            summary: '在 SLM 上画出一片"像素级凸透镜"：每个像素的相位延迟与它到中心的距离平方成正比（φ = -πr²/λf）。灰度 0–255 对应相位 0–2π。反射光经过它，就像经过真实玻璃透镜一样会聚到焦点——只是这片"透镜"是软件画的，焦距随改随用。',
            svg: svgOpen() +
                beamIn(24, 110) +
                `<circle class="th-panel" cx="205" cy="140" r="58"></circle>` +
                `<circle class="th-ring" cx="205" cy="140" r="46"></circle>` +
                `<circle class="th-ring" cx="205" cy="140" r="34"></circle>` +
                `<circle class="th-ring" cx="205" cy="140" r="22"></circle>` +
                `<circle class="th-ring" cx="205" cy="140" r="11"></circle>` +
                `<path class="th-flow th-ray" d="M263,140 C340,138 440,136 512,139"></path>` +
                `<path class="th-flow th-ray" d="M258,122 C350,110 450,124 510,135"></path>` +
                `<path class="th-flow th-ray" d="M258,158 C350,170 450,156 510,145"></path>` +
                spot(520, 140, 9) +
                lbl(205, 224, '同心环带相位（越靠外越密）') +
                lbl(560, 146, '焦点（焦距 f 处）', 'start') +
                lbl(24, 108, '入射平行光', 'start', 'th-label') +
                lbl(360, 258, '环带间距由焦距 f 和波长 λ 决定：f 越大，环越稀疏') +
                svgClose(),
            points: [
                'φ(r) = -πr²/(λf)：平方律相位 = 薄透镜近似',
                'pitch_mode 选择像素间距 20µm / 1.25µm',
                '支持旋转、偏移、缩放与图像叠加（图像变暗透镜区域）',
                '输出 1272×1024 8-bit BMP，直接写入 SLM'
            ]
        },

        'fresnel-three-spots': {
            title: '菲涅尔多点聚焦（三点聚焦）',
            summary: '一张相位图同时干两件事：底层是"透镜相位"负责把光聚到焦距处；上层是"分束相位"决定焦面上亮斑的数量与位置。两者逐像素相加（相位可叠加，模 2π 后取整为灰度）。焦面上的多个亮斑本质是同一束光的衍射级次之间的干涉堆叠。',
            svg: svgOpen() +
                beamIn(24, 110) +
                panel(126, 85, 44, 110) +
                `<path class="th-flow th-ray" d="M170,115 C280,100 460,80 512,88"></path>` +
                `<path class="th-flow th-ray" d="M170,140 C300,140 460,142 512,140"></path>` +
                `<path class="th-flow th-ray" d="M170,165 C280,180 460,200 512,192"></path>` +
                `<ellipse class="th-struct" cx="360" cy="140" rx="12" ry="52"></ellipse>` +
                spot(520, 88) + spot(520, 140) + spot(520, 192) +
                lbl(148, 218, '相位图 = 透镜 + 分束') +
                lbl(360, 214, '透镜相位（聚焦）') +
                lbl(548, 142, '焦面点阵', 'start') +
                lbl(360, 258, '分束相位由所选算法生成：等强光栅 / WGS 迭代 / 达曼 / 解析叠加') +
                svgClose(),
            points: [
                '均匀光栅：设计相位单元让每级等功率，照明鲁棒（默认）',
                '高斯优化 WGS：正反 FFT 迭代，精确控制每点位置/权重/半径',
                '达曼光栅：0/π 二元相位，仅 3 点水平等距，效率约 66%',
                '解析叠加：直接写各点球面波相位，一步出图，适合诊断',
                '支持自定义二维光斑阵列（编辑器拖动，1~15 个点）'
            ]
        },

        'three-spots-no-lens': {
            title: '三点聚焦（无透镜）',
            summary: '去掉透镜相位，只保留"纯分束光栅"。反射光不聚焦，而是被偏折成 n 束平行光，彼此夹角由点间距决定——亮斑形成在无穷远或外部光学系统的焦面上。选 1 个点时相位为常数（零级直通）。',
            svg: svgOpen() +
                beamIn(24, 110) +
                `<rect class="th-panel" x="126" y="85" width="44" height="110" rx="8"></rect>` +
                [100, 118, 136, 154, 172, 190].map(y =>
                    `<line class="th-stripe" x1="132" y1="${y}" x2="164" y2="${y}"></line>`).join('') +
                `<line class="th-flow th-ray" d="M170,100 L560,70"></line>` +
                `<line class="th-flow th-ray" d="M170,140 L560,140"></line>` +
                `<line class="th-flow th-ray" d="M170,180 L560,210"></line>` +
                spot(568, 70) + spot(568, 140) + spot(568, 210) +
                lbl(148, 218, '相位光栅（条纹方向决定分束方向）') +
                lbl(600, 142, '远场平行束', 'start') +
                lbl(360, 258, '点间距 d 越大，出射夹角越大：θ ≈ λ/d') +
                svgClose(),
            points: [
                '纯线性相位 = 棱镜阵列，不含聚焦项',
                '常配合外部聚焦透镜或远场衍射使用',
                'uniform_grating 等强 / gaussian_wgs 优化 / damann 快速 / analytic 诊断',
                'n=1 时输出常数相位（0 阶直通）'
            ]
        },

        'double-ring': {
            title: '内外圈复合光斑',
            summary: '目标图案是"中心一个高斯亮斑 + 外圈一个亮环"（两圈强度都可调）。由于这种目标无法一步写出解析相位，模块用迭代优化反解：反复在 SLM 面与焦面之间做傅里叶变换，每次把焦面强度往目标拉，同时锁定 SLM 面只保留相位，直至收敛。',
            svg: svgOpen() +
                `<circle class="th-spot" cx="140" cy="140" r="16"></circle>` +
                `<circle class="th-ring" cx="140" cy="140" r="52"></circle>` +
                lbl(140, 224, '目标：中心斑 + 外圈环') +
                `<rect class="th-panel" x="310" y="95" width="90" height="90" rx="8"></rect>` +
                lbl(355, 85, '相位域（SLM 面）') +
                `<path class="th-flow th-cycle" d="M300,120 C270,110 270,170 300,160"></path>` +
                `<path class="th-flow th-cycle" d="M410,160 C440,170 440,110 410,120"></path>` +
                `<rect class="th-panel" x="470" y="95" width="90" height="90" rx="8"></rect>` +
                lbl(515, 85, '焦面域（强度约束）') +
                `<path class="th-flow th-ray" d="M560,140 C590,138 620,142 648,140"></path>` +
                spot(660, 140, 9) +
                lbl(360, 258, '每次迭代：逆 FFT 取相位 → 正 FFT 强制幅度 → 重复') +
                svgClose(),
            points: [
                '内圈/外圈半径与宽度独立可调',
                '三区间强度（内圈/圈间/外圈）按权重分配能量',
                '迭代次数默认 100，越多越贴近目标',
                '输出实数相位图，可与其他模块结果叠加使用'
            ]
        },

        axicon: {
            title: '轴棱锥透镜',
            summary: '相位沿半径方向线性增长（像一个玻璃锥面）。平行光经过它不再聚成一个点，而是折向同一个锥角，形成一束"无衍射"的 Bessel 光——中心亮斑沿光轴传播很长的距离不扩散，远场则是一个圆环。',
            svg: svgOpen() +
                beamIn(24, 120, [125, 155]) +
                `<path class="th-struct" d="M170,90 L200,140 L170,190 Z" fill="none"></path>` +
                `<path class="th-flow th-ray" d="M170,125 L340,105 L560,105"></path>` +
                `<path class="th-flow th-ray" d="M170,155 L340,175 L560,175"></path>` +
                `<circle class="th-ring" cx="600" cy="140" r="34"></circle>` +
                `<circle class="th-spot th-pulse" cx="600" cy="140" r="6"></circle>` +
                lbl(185, 218, '锥形相位（径向线性）') +
                lbl(600, 196, '远场圆环', 'middle') +
                lbl(360, 258, '锥角（半径参数）决定环半径与无衍射距离') +
                svgClose(),
            points: [
                '径向相位 φ = k·r·tanα：与半径成正比（线性，非平方）',
                '产生长焦深、抗衍射扩散的 Bessel 型光束',
                '远场强度分布为中心亮环',
                '常用于粒子导引、微加工等长程直线光场'
            ]
        },

        cylindrical: {
            title: '柱面透镜',
            summary: '只在一个方向上"有曲率"的透镜：相位沿 x 方向按平方律变化、沿 y 方向不变（或反过来）。平行光经过后只在该方向被会聚，另一个方向照常传播，于是焦点是一条亮线而不是一个点。',
            svg: svgOpen() +
                beamIn(24, 110, [100, 125, 155, 180]) +
                `<rect class="th-panel" x="130" y="80" width="40" height="120" rx="8"></rect>` +
                `<path class="th-flow th-ray" d="M170,100 C280,105 420,128 512,134"></path>` +
                `<path class="th-flow th-ray" d="M170,125 C280,128 420,136 512,137"></path>` +
                `<path class="th-flow th-ray" d="M170,155 C280,152 420,144 512,143"></path>` +
                `<path class="th-flow th-ray" d="M170,180 C280,175 420,152 512,146"></path>` +
                `<line class="th-spotline th-pulse" x1="514" y1="112" x2="514" y2="168"></line>` +
                lbl(150, 224, '柱面相位（单向抛物线）') +
                lbl(560, 142, '线焦点', 'start') +
                lbl(360, 258, '方向可选水平/垂直；焦距决定线焦距离') +
                svgClose(),
            points: [
                '一维透镜：φ(x) = -πx²/(λf)，y 方向相位恒定',
                '焦点为一条亮线（线焦），长度由光束尺寸决定',
                '用于激光划线、沿线均匀照明等场景'
            ]
        },

        blaze: {
            title: '闪耀光栅',
            summary: '相位在每个周期内从 0 线性爬升到 2π 再瞬间归零，形成锯齿。它等效于一排微型棱镜：几乎全部能量被偏折进唯一的 +1 级方向（普通光栅会把能量摊给 ±1、±2…多级），是效率最高的单方向分束器。',
            svg: svgOpen() +
                beamIn(24, 110, [130, 150]) +
                `<polyline class="th-struct" points="130,110 150,90 150,110 170,90 170,110 190,90 190,110 210,90 210,110 230,90 230,110 250,90 250,110 262,100"></polyline>` +
                `<path class="th-flow th-ray" d="M266,140 L560,105"></path>` +
                spot(568, 105, 9) +
                `<path class="th-leak" d="M266,145 L560,178"></path>` +
                lbl(196, 140, '锯齿相位（周期 T）') +
                lbl(600, 100, '+1 级（全部能量）', 'start') +
                lbl(600, 182, '高级次（几乎为 0）', 'start') +
                lbl(360, 258, '周期越大偏折角越小；相位归一化保证连续锯齿') +
                svgClose(),
            points: [
                '锯齿相位 = 微棱镜阵列，理论衍射效率接近 100%',
                '偏折方向由锯齿方向（水平/垂直）决定',
                '常用于光束偏转、光镊拖动微粒'
            ]
        },

        sine: {
            title: '正弦光栅',
            summary: '相位沿一个方向按正弦规律平滑变化。它天然只有 ±1 级两个衍射方向，入射能量被对称地分给左右（或上下）两束，中间 0 级几乎不出光——是生成"两束等强输出"的简洁方案。',
            svg: svgOpen() +
                beamIn(24, 110, [140, 160]) +
                `<path class="th-struct" d="M126,140 q11,-26 22,0 t22,0 t22,0 t22,0 t22,0 t22,0"></path>` +
                `<path class="th-flow th-ray" d="M240,140 L520,80"></path>` +
                `<path class="th-flow th-ray" d="M240,140 L520,200"></path>` +
                `<path class="th-leak" d="M240,140 L520,140"></path>` +
                spot(528, 80, 8) + spot(528, 200, 8) +
                lbl(190, 96, '正弦相位') +
                lbl(600, 74, '+1 级', 'start') +
                lbl(600, 204, '-1 级', 'start') +
                lbl(600, 144, '0 级（暗）', 'start') +
                lbl(360, 258, '光栅周期决定两束之间的夹角') +
                svgClose(),
            points: [
                'φ(x) = A·sin(2πx/T)：平滑、无跳变',
                '输出两束对称等强的衍射光',
                '适合干涉仪、双光束照明等场景'
            ]
        },

        vortex: {
            title: '涡旋光束',
            summary: '相位围绕中心按方位角旋转式增长（φ = ℓ·θ，ℓ 为拓扑荷）。中心是一个相位奇异点——光在那里互相抵消，形成中空暗核，整体呈环形亮斑，并且整束光携带轨道角动量，可以带动微粒旋转。',
            svg: svgOpen() +
                beamIn(24, 110, [135, 155]) +
                `<circle class="th-panel" cx="230" cy="140" r="66"></circle>` +
                `<g class="th-spin-group"><g class="th-spin">` +
                `<path class="th-spiral" d="M230,140 m0,-4 a4,4 0 1,1 -4,4 a12,12 0 1,1 12,-12 a26,26 0 1,1 -26,26 a44,44 0 1,1 44,-44 a62,62 0 1,1 -62,62"></path>` +
                `</g></g>` +
                `<path class="th-flow th-ray" d="M296,140 C380,120 470,110 546,116"></path>` +
                `<path class="th-flow th-ray" d="M296,140 C380,160 470,170 546,164"></path>` +
                `<circle class="th-ring" cx="580" cy="140" r="30"></circle>` +
                `<circle class="th-dark" cx="580" cy="140" r="8"></circle>` +
                lbl(230, 232, '螺旋相位 exp(iℓθ)（旋转动画）') +
                lbl(580, 190, '环形光斑（中心暗核）') +
                lbl(360, 258, '拓扑荷 ℓ（lnumber）越大，环越粗') +
                svgClose(),
            points: [
                '中心相位无定义 → 焦斑中空（暗核）',
                '拓扑荷 ℓ 决定环半径与角动量大小',
                '可驱动微粒旋转（光致转动）',
                '与透镜相位可叠加，形成聚焦涡旋'
            ]
        },

        random: {
            title: '随机散斑',
            summary: '给每个像素一个随机相位。随机的波前在远场互相干涉，形成颗粒状、位置统计随机的"散斑"图案——这是激光穿过毛玻璃/散射介质的经典现象，用于散射照明、统计光学实验与去斑算法研究。',
            svg: svgOpen() +
                `<g class="th-rand">` +
                Array.from({ length: 42 }, (_, i) => {
                    const x = 120 + (i % 7) * 16 + ((i * 37) % 9);
                    const y = 88 + Math.floor(i / 7) * 15 + ((i * 23) % 8);
                    return `<rect class="th-pixel th-pulse" x="${x}" y="${y}" width="10" height="10" rx="2" style="animation-delay:${(i % 5) * 0.3}s"></rect>`;
                }).join('') +
                `</g>` +
                `<path class="th-flow th-ray" d="M290,140 L400,140"></path>` +
                `<text class="th-label" x="345" y="128" text-anchor="middle">FFT</text>` +
                `<g class="th-speckle">` +
                Array.from({ length: 30 }, (_, i) => {
                    const x = 440 + (i * 53) % 210;
                    const y = 90 + (i * 37) % 100;
                    const r = 4 + (i % 4) * 2;
                    return `<circle class="th-spot" cx="${x}" cy="${y}" r="${r}" style="animation-delay:${(i % 7) * 0.22}s"></circle>`;
                }).join('') +
                `</g>` +
                lbl(160, 224, '随机相位（每像素独立）') +
                lbl(545, 224, '远场散斑强度') +
                lbl(360, 258, 'seed 参数固定随机种子，可复现同一散斑') +
                svgClose(),
            points: [
                '随机相位 = 均匀覆盖所有空间频率',
                '散斑颗粒尺寸由照明孔径与波长决定',
                '固定 seed 可复现；换 seed 得到新图案',
                '常作为散射介质模拟与统计光学训练数据'
            ]
        },

        divide: {
            title: '分屏图案',
            summary: '把 SLM 面分成左右（或上下）两半，两半各加载一种相位图案，在同一块器件上同时输出两种光场——方便同屏对比不同参数/算法的实际效果。',
            svg: svgOpen() +
                `<rect class="th-panel" x="126" y="85" width="40" height="110" rx="8"></rect>` +
                `<line class="th-stripe" x1="132" y1="110" x2="160" y2="110"></line>` +
                `<line class="th-stripe" x1="132" y1="140" x2="160" y2="140"></line>` +
                `<line class="th-stripe" x1="132" y1="170" x2="160" y2="170"></line>` +
                `<line x1="146" y1="85" x2="146" y2="195" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"></line>` +
                `<path class="th-flow th-ray" d="M166,110 L520,90"></path>` +
                `<path class="th-flow th-ray" d="M166,170 L520,190"></path>` +
                lbl(146, 72, '分屏分界') +
                lbl(146, 218, 'A 图案', 'middle') + lbl(146, 236, '与 B 图案', 'middle') +
                spot(528, 90) + spot(528, 190) +
                lbl(600, 94, '输出 A 光场', 'start') +
                lbl(600, 194, '输出 B 光场', 'start') +
                lbl(360, 258, '两半独立设参，一屏同验两种方案') +
                svgClose(),
            points: [
                '两种相位（如不同周期光栅 / 透镜）各占一半',
                '同屏对比可排除时序漂移干扰',
                '常用于参数筛选与教学演示'
            ]
        },

        cross: {
            title: '十字测试图',
            summary: '直接输出固定的十字标线图案（不做任何光学计算）。用于相机与光路的对准、SLM 面位置标定、以及验证 USB 链路像素一一对应关系。',
            svg: svgOpen() +
                `<rect class="th-panel" x="126" y="85" width="40" height="110" rx="8"></rect>` +
                `<line class="th-cross" x1="146" y1="100" x2="146" y2="180"></line>` +
                `<line class="th-cross" x1="121" y1="140" x2="171" y2="140"></line>` +
                `<path class="th-flow th-ray" d="M166,140 L500,140"></path>` +
                `<line class="th-cross" x1="560" y1="110" x2="560" y2="170"></line>` +
                `<line class="th-cross" x1="530" y1="140" x2="590" y2="140"></line>` +
                lbl(146, 218, 'SLM 显示') +
                lbl(560, 196, '相机观察') +
                lbl(360, 258, '十字对准 = 像素级映射正确；偏移量即标定值') +
                svgClose(),
            points: [
                '固定二值图案，无参数依赖',
                '用于对准相机、检查像素映射',
                '配合分屏可同时显示标定与测试图案'
            ]
        },

        'cgh-simulation': {
            title: 'CGH Simulation（计算全息）',
            summary: '给定一张目标图（想让焦面出现什么图案），用 Gerchberg-Saxton 迭代反解相位全息图：目标幅度与相位图之间来回做傅里叶变换，每次在目标面强制幅度等于目标图、在 SLM 面只保留相位，循环直到误差收敛。',
            svg: svgOpen() +
                `<rect class="th-panel" x="120" y="95" width="110" height="90" rx="8"></rect>` +
                lbl(175, 85, '目标图（幅度约束）') +
                `<path class="th-flow th-cycle" d="M230,120 C270,95 310,95 340,120"></path>` +
                `<path class="th-flow th-cycle2" d="M340,160 C310,185 270,185 230,160"></path>` +
                lbl(285, 106, 'FFT', 'middle') + lbl(285, 182, '逆 FFT', 'middle') +
                `<rect class="th-panel" x="340" y="95" width="110" height="90" rx="8"></rect>` +
                lbl(395, 85, '相位全息图（只留相位）') +
                `<path class="th-flow th-ray" d="M450,140 L540,140"></path>` +
                `<rect class="th-panel" x="540" y="95" width="110" height="90" rx="8"></rect>` +
                lbl(595, 85, '重构目标图') +
                lbl(360, 258, '迭代次数越多越接近目标；相位 ∈ [0, 2π)') +
                svgClose(),
            points: [
                'GS 迭代：目标面锁幅度、SLM 面锁相位',
                '支持上传目标图 / 画板轨迹 / 主程序图案',
                '收敛后输出 8-bit 相位 BMP'
            ]
        },

        'bmp-converter': {
            title: 'BMP 转换器',
            summary: 'SLM 硬件只认一种图：1272×1024 的 8-bit 灰度 BMP。转换器把任意图像缩放到目标尺寸、转为灰度（可加二值化等处理），输出标准 BMP——这是所有相位图上传硬件前的最后一站。',
            svg: svgOpen() +
                `<rect class="th-panel" x="110" y="95" width="110" height="90" rx="8"></rect>` +
                `<circle class="th-spot" cx="150" cy="130" r="16"></circle>` +
                `<rect class="th-stripe" x="175" y="115" width="24" height="30" rx="3"></rect>` +
                lbl(165, 85, '任意输入图像') +
                `<path class="th-flow th-ray" d="M220,140 L300,140"></path>` +
                lbl(260, 128, '缩放 · 灰度化', 'middle') +
                `<rect class="th-panel" x="300" y="95" width="140" height="90" rx="8"></rect>` +
                [110, 130, 150, 170].map(y =>
                    `<line class="th-stripe" x1="310" y1="${y}" x2="430" y2="${y}"></line>`).join('') +
                lbl(370, 85, '1272×1024 · 8-bit 灰度') +
                `<path class="th-flow th-ray" d="M440,140 L510,140"></path>` +
                `<rect class="th-struct" x="510" y="95" width="130" height="90" rx="8"></rect>` +
                lbl(575, 145, '标准 BMP 文件') +
                lbl(360, 258, '非整数尺寸自动等比缩放；输出可直接写入帧存槽位') +
                svgClose(),
            points: [
                '目标尺寸固定 1272×1024（SXGA）',
                '8-bit 灰度 = 相位量化 256 级',
                '转换结果可直接下载或发送到 USB_SLMControl'
            ]
        },

        'fourier-sim': {
            title: '傅里叶面强度模拟',
            summary: '生成相位图后不必真上硬件：对相位图做一次数值傅里叶变换（FFT），就等于让光"虚拟地"到达焦面。叠加高斯/均匀照明后取模平方，即得到预测的焦面强度分布——用来在打光之前快速验证算法效果。',
            svg: svgOpen() +
                `<rect class="th-panel" x="110" y="95" width="130" height="90" rx="8"></rect>` +
                [110, 135, 160].map(y =>
                    `<line class="th-stripe" x1="122" y1="${y}" x2="228" y2="${y}"></line>`).join('') +
                lbl(175, 85, '相位图（SLM 面）') +
                `<path class="th-flow th-ray" d="M240,140 L330,140"></path>` +
                lbl(285, 128, 'FFT × 照明', 'middle') +
                `<ellipse class="th-struct" cx="360" cy="140" rx="14" ry="45"></ellipse>` +
                `<path class="th-flow th-ray" d="M374,140 L450,140"></path>` +
                `<g class="th-speckle">` +
                [[480, 110, 9], [500, 145, 7], [525, 105, 6], [555, 150, 8], [580, 118, 6], [610, 145, 9], [640, 110, 6], [500, 175, 5], [590, 178, 7]].map(p =>
                    `<circle class="th-spot" cx="${p[0]}" cy="${p[1]}" r="${p[2]}" style="animation-delay:${(p[0] % 5) * 0.2}s"></circle>`).join('') +
                `</g>` +
                lbl(560, 85, '预测焦面强度（伪彩）') +
                lbl(360, 258, '照明可选高斯/均匀；伪彩映射 magma/jet 等') +
                svgClose(),
            points: [
                'FFT = 数值 equivalent of 光到达焦面',
                '高斯照明考虑真实光束的强度包络',
                '支持单帧与序列模拟、导出 GIF'
            ]
        },

        'paint-board': {
            title: '动态全息绘图板',
            summary: '在画板上手绘轨迹或放置动画元素，软件把笔画/运动逐帧转成相位动画序列：每一帧都是一张相位图，按时间顺序播放即可在焦面"画出"运动的光点轨迹。',
            svg: svgOpen() +
                `<rect class="th-panel" x="110" y="85" width="150" height="110" rx="8"></rect>` +
                `<path class="th-spiral" d="M130,160 C160,110 200,110 220,150 C235,175 200,185 180,165"></path>` +
                `<circle class="th-spot th-pulse" cx="222" cy="152" r="6"></circle>` +
                lbl(185, 218, '手绘轨迹 + FPS') +
                `<path class="th-flow th-ray" d="M260,140 L310,140"></path>` +
                [0, 1, 2].map(i =>
                    `<rect class="th-panel" x="${320 + i * 70}" y="${i === 1 ? 75 : 95}" width="52" height="70" rx="6"></rect>` +
                    `<path class="th-flow th-cycle" d="M${330 + i * 70},${150 - i * 8} C${345 + i * 70},${110 - i * 8} ${360 + i * 70},${140 - i * 8} ${368 + i * 70},${125 - i * 8}"></path>`
                ).join('') +
                lbl(420, 62, '逐帧相位序列') +
                `<path class="th-flow th-ray" d="M560,140 L600,140"></path>` +
                `<circle class="th-spot th-pulse" cx="620" cy="140" r="8"></circle>` +
                lbl(620, 170, '播放', 'middle') +
                lbl(360, 258, '帧率与时长可控；导出 GIF 或加入播放序列') +
                svgClose(),
            points: [
                '画笔轨迹 → 每帧局部相位点',
                '支持动画元素（移动/旋转）自动生成帧',
                '预览播放、导出 GIF、加入 USB 序列'
            ]
        },

        'usb-slm': {
            title: 'USB_SLMControl（硬件控制）',
            summary: '把软件里的相位图真正送到 SLM 硬件：UI 调用 Flask API，经 32 位桥接进程驱动滨松 hpkSLMdaLV.dll，通过 USB 控制器把 1272×1024 图像写入 SLM 的帧存储槽位并切换显示；序列播放按 CSV 时序（槽位,毫秒）循环切换。',
            svg: svgOpen() +
                [['UI 界面', 110], ['Flask API', 270], ['32位桥 + DLL', 430], ['SLM 控制器', 590]].map(n =>
                    `<rect class="th-panel" x="${n[1] - 55}" y="105" width="110" height="60" rx="8"></rect>` +
                    lbl(n[1], 140, n[0])).join('') +
                `<line class="th-flow th-ray" x1="165" y1="135" x2="215" y2="135"></line>` +
                `<line class="th-flow th-ray" x1="325" y1="135" x2="375" y2="135"></line>` +
                `<line class="th-flow th-ray" x1="485" y1="135" x2="535" y2="135"></line>` +
                `<rect class="th-struct" x="250" y="205" width="220" height="42" rx="8"></rect>` +
                lbl(360, 231, 'Sequence.csv：槽位,毫秒 → 循环切换') +
                `<path class="th-flow th-cycle" d="M360,205 L360,172"></path>` +
                lbl(360, 90, '帧存 0~818 槽 · SD 卡 0~5658 槽') +
                svgClose(),
            points: [
                '驱动三层：64 位直连 / 32 位桥（LabVIEW 2018）/ 模拟',
                '帧存 819 槽 + SD 卡 5659 槽，支持 SD→FMem 上传',
                '序列播放与原版 USB_SLMControl.exe 的 CSV 格式一致',
                '实时状态：序列号、双温度、LED、IO、DVI/USB 模式'
            ]
        },

        'spot-motion': {
            title: '三光斑独立运动',
            summary: '三个焦斑各自绑定一种材料标记，沿规划路径（μm 坐标）独立运动。显微镜实时画面提供位置反馈——每帧用局部搜索测量光斑实际位置，与路径目标比较后按补偿增益修正相位，形成"生成→测量→补偿"闭环，让光斑在样品上不偏离规划路线。',
            svg: svgOpen() +
                `<rect class="th-panel" x="100" y="80" width="200" height="120" rx="8"></rect>` +
                [[150, 115, '#e2543f'], [205, 140, '#2e9e6b'], [250, 165, '#2e6b9e']].map(p =>
                    `<circle class="th-spot th-pulse" cx="${p[0]}" cy="${p[1]}" r="7" style="fill:${p[2]};animation-delay:${p[0] * 0.004}s"></circle>` +
                    `<path class="th-flow th-cycle" d="M${p[0]},${p[1]} C${p[0] + 30},${p[1] - 25} ${p[0] + 60},${p[1] + 15} ${p[0] + 90},${p[1] - 10}"></path>`
                ).join('') +
                lbl(200, 224, '三光斑各自沿路径运动（显微画面闭环）') +
                `<rect class="th-panel" x="420" y="80" width="240" height="120" rx="8"></rect>` +
                lbl(540, 100, '闭环流程') +
                lbl(540, 125, '① 路径 → 相位帧', 'middle') +
                lbl(540, 148, '② 局部搜索测实际光斑位置', 'middle') +
                lbl(540, 171, '③ 增益补偿 → 更新相位', 'middle') +
                `<path class="th-flow th-cycle" d="M470,160 C440,160 440,120 470,120"></path>` +
                lbl(360, 258, '坐标换算：px/μm 标定 × 焦平面比例（50× 物镜等）') +
                svgClose(),
            points: [
                '材料标记绑定光斑：显微镜图上点选样品位置',
                '标定：设置原点 + 两点标尺（px/μm）',
                '路径编辑：每光斑独立路径点序列（μm，纵轴向上）',
                '闭环反馈：搜索半径内测光斑，按增益修正漂移'
            ]
        },

        'sequence-panel': {
            title: '序列播放控制',
            summary: '把多张相位图按时间顺序组织成动画：每帧一张相位图、一个播放间隔，可循环。浏览器内预览时逐帧替换主预览区图像；连接 USB_SLMControl 后，同一序列可下发到硬件帧存槽位，按毫秒级时序真实播放。',
            svg: svgOpen() +
                `<rect class="th-panel" x="120" y="90" width="90" height="70" rx="8"></rect>` +
                `<rect class="th-panel" x="225" y="90" width="90" height="70" rx="8"></rect>` +
                `<rect class="th-panel" x="330" y="90" width="90" height="70" rx="8"></rect>` +
                `<rect class="th-struct" x="435" y="90" width="90" height="70" rx="8"></rect>` +
                lbl(165, 128, '帧 1') + lbl(270, 128, '帧 2') + lbl(375, 128, '帧 3') + lbl(480, 128, '…') +
                `<path class="th-flow th-ray" d="M210,125 L225,125"></path>` +
                `<path class="th-flow th-ray" d="M315,125 L330,125"></path>` +
                `<path class="th-flow th-ray" d="M420,125 L435,125"></path>` +
                `<circle class="th-spot th-pulse" cx="165" cy="125" r="6"></circle>` +
                lbl(165, 180, '播放头（间隔 ms）') +
                `<path class="th-flow th-cycle" d="M560,125 C580,110 580,140 560,125"></path>` +
                lbl(620, 130, '循环', 'middle') +
                lbl(360, 240, '同一序列既可浏览器预览，也可写入 SLM 硬件按毫秒时序播放') +
                svgClose(),
            points: [
                '帧来源：各模块"添加到序列"或绘图板动画',
                '播放间隔 100~10000ms，支持循环',
                '配合 USB_SLMControl 可硬件级毫秒时序播放'
            ]
        }
    };

    // ==================== 弹窗 ====================
    let overlay = null;

    function buildModal() {
        overlay = document.createElement('div');
        overlay.className = 'theory-overlay';
        overlay.id = 'theory_overlay';
        overlay.innerHTML = `
            <div class="theory-modal" role="dialog" aria-modal="true">
                <div class="theory-header">
                    <h3 id="theory_title">模块原理</h3>
                    <button type="button" class="theory-close" aria-label="关闭">&times;</button>
                </div>
                <div class="theory-body">
                    <p class="theory-summary" id="theory_summary"></p>
                    <div class="theory-figure" id="theory_figure"></div>
                    <ul class="theory-points" id="theory_points"></ul>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.theory-close').addEventListener('click', closeTheory);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeTheory();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('open')) closeTheory();
        });
    }

    function showModuleTheory(moduleId) {
        const item = THEORY[moduleId];
        if (!item || !overlay) return;
        document.getElementById('theory_title').textContent = item.title + ' · 模型原理';
        document.getElementById('theory_summary').textContent = item.summary;
        document.getElementById('theory_figure').innerHTML = item.svg;
        const ul = document.getElementById('theory_points');
        ul.replaceChildren(...item.points.map(p => {
            const li = document.createElement('li');
            li.textContent = p;
            return li;
        }));
        overlay.classList.add('open');
    }

    function closeTheory() {
        if (overlay) overlay.classList.remove('open');
    }

    function injectButtons() {
        buildModal();
        document.querySelectorAll('.module-card[id]').forEach(card => {
            const id = card.id;
            if (!THEORY[id]) return;
            let actions = card.querySelector('.module-actions');
            if (!actions) {
                // 部分 module-header 没有 actions 容器，自动创建
                const header = card.querySelector('.module-header');
                if (!header) return;
                actions = document.createElement('div');
                actions.className = 'module-actions';
                header.appendChild(actions);
            }
            if (actions.querySelector('.theory-btn')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-icon theory-btn';
            btn.title = '模型原理';
            btn.setAttribute('aria-label', item_title(id) + ' 原理说明');
            btn.textContent = '?';
            btn.addEventListener('click', () => showModuleTheory(id));
            actions.insertBefore(btn, actions.firstChild);
        });
    }

    function item_title(id) {
        return THEORY[id] ? THEORY[id].title : '模块';
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectButtons);
    } else {
        injectButtons();
    }

    window.showModuleTheory = showModuleTheory;
})();
