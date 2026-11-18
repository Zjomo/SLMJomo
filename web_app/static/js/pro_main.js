/**
 * LCOS-SLM 专业控制面板 - 前端交互逻辑
 * 模拟官方SLM软件功能
 */

// ==================== 全局状态管理 ====================
const AppState = {
    currentImageData: null,
    currentPatternType: null,
    generationInProgress: false,
    history: [],
    uploadedImage: null,
    sequenceList: [],
    sequenceIndex: 0,
    isPlaying: false,
    playInterval: null,
    deviceConnected: false,
    zoomLevel: 1,
    cghData: {
        targetImage: null,
        cghImage: null,
        regeneratedImage: null,
        lightShapeImage: null,
        filename: null
    },
    cghVideo: {
        frames: [],
        index: 0,
        timer: null,
        playing: false,
        calculating: false
    }
};

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
    initializeSliders();
    initializeDragDrop();
    updateTime();
    setInterval(updateTime, 1000);
});

function initializeApp() {
    console.log('LCOS-SLM 专业控制面板已加载');
    loadHistory();
    loadPresets();
    initializeCGHUpload();
    initializeCGHShapeHint();
    initializeCGHVideoUpload();
    initializeConverterUpload();
    toggleThreeSpotOptimization();
    initializeThreeSpotDammannInfo();
    toggleThreeSpotOptimization('tsn');
    initializeThreeSpotDammannInfo('tsn');
    initializeCylindricalDiag();
    initializeDoubleRing();
}

function initializeCylindricalDiag() {
    ['cylindrical_focal_length', 'cylindrical_wavelength', 'cylindrical_pixel_size',
        'cylindrical_beam_diameter', 'cylindrical_width']
        .forEach(id => {
            const input = document.getElementById(id);
            if (input) input.addEventListener('input', updateCylindricalDiag);
        });
    updateCylindricalDiag();
}

function updateCylindricalDiag() {
    const fwhmOut = document.getElementById('cyl_diag_fwhm');
    const fminOut = document.getElementById('cyl_diag_fmin');
    const minWidthOut = document.getElementById('cyl_diag_min_width');
    const adviceOut = document.getElementById('cyl_diag_advice');
    if (!fwhmOut) return;

    const focalLength = parseFloat(document.getElementById('cylindrical_focal_length').value);
    const wavelength = parseFloat(document.getElementById('cylindrical_wavelength').value);
    const pixelSize = parseFloat(document.getElementById('cylindrical_pixel_size').value);
    const beamDiameter = parseFloat(document.getElementById('cylindrical_beam_diameter').value);
    const width = parseInt(document.getElementById('cylindrical_width').value);

    if (!(focalLength > 0) || !(wavelength > 0) || !(pixelSize > 0) || !(width > 0)) {
        fwhmOut.textContent = fminOut.textContent = minWidthOut.textContent = adviceOut.textContent = '-';
        return;
    }

    // 单位统一为 mm：λ nm→mm，像素 µm→mm
    const lambdaMm = wavelength / 1e6;
    const apertureMm = width * pixelSize / 1000;
    const beam = beamDiameter > 0 ? beamDiameter : apertureMm;

    // 高斯照明焦线宽度（强度 FWHM）：w = sqrt(2*ln2)*λf/(π*w0)，w0=1/e 振幅半径
    const w0 = beam / 2;
    const fwhmUm = Math.sqrt(2 * Math.log(2)) * lambdaMm * focalLength / (Math.PI * w0) * 1000;

    // 采样极限：边缘条纹周期 ≥ 2 像素 → f_min = D_SLM·p/λ
    const fMinMm = apertureMm * (pixelSize / 1000) / lambdaMm;

    // 扩束到满口径后的极限线宽（受采样极限 f_min 约束）
    const fForMin = Math.min(focalLength, fMinMm);
    const minWidthUm = Math.sqrt(2 * Math.log(2)) * lambdaMm * fForMin / (Math.PI * apertureMm / 2) * 1000;

    fwhmOut.textContent = `${fwhmUm.toFixed(1)} µm`;
    fminOut.textContent = `${fMinMm.toFixed(0)} mm`;
    minWidthOut.textContent = `${minWidthUm.toFixed(1)} µm`;

    let advice;
    if (focalLength < fMinMm) {
        advice = `焦距低于混叠极限 ${fMinMm.toFixed(0)} mm，边缘相位欠采样会使焦线变差，请增大焦距`;
    } else if (beam < apertureMm * 0.9) {
        advice = `扩束到 ${apertureMm.toFixed(1)} mm（满口径）可将焦线细至约 ${minWidthUm.toFixed(1)} µm`;
    } else if (focalLength > fMinMm * 1.5) {
        advice = `焦距已接近下限，线宽约 ${minWidthUm.toFixed(1)} µm 已接近纯相位极限，更细需真实柱面透镜`;
    } else {
        advice = `参数已接近最优，焦线宽度约 ${fwhmUm.toFixed(1)} µm`;
    }
    adviceOut.textContent = advice;
}

function initializeDoubleRing() {
    if (document.getElementById('double_ring_inner_radius')) {
        initializeDoubleRingControls();
        renderDoubleRingTargetPreview();
        setTimeout(() => generateDoubleRing(false), 350);
    }
}

function initializeDoubleRingControls() {
    const pairs = [
        ['double_ring_inner_radius', 'double_ring_inner_radius_slider'],
        ['double_ring_outer_radius', 'double_ring_outer_radius_slider'],
        ['double_ring_inner_width', 'double_ring_inner_width_slider'],
        ['double_ring_outer_width', 'double_ring_outer_width_slider'],
        ['double_ring_inner_intensity', 'double_ring_inner_intensity_slider'],
        ['double_ring_outer_intensity', 'double_ring_outer_intensity_slider'],
        ['double_ring_between_intensity', 'double_ring_between_intensity_slider']
    ];
    pairs.forEach(([inputId, sliderId]) => {
        const input = document.getElementById(inputId);
        const slider = document.getElementById(sliderId);
        if (!input || !slider) return;
        input.addEventListener('input', () => {
            slider.value = input.value;
            scheduleDoubleRingPreview();
        });
        slider.addEventListener('input', () => {
            input.value = slider.value;
            scheduleDoubleRingPreview();
        });
    });
    ['double_ring_width', 'double_ring_height'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.addEventListener('input', () => {
            updateDoubleRingRadiusLimits();
            scheduleDoubleRingPreview();
        });
    });
    updateDoubleRingRadiusLimits();
    syncDoubleRingSliders();
}

function updateDoubleRingRadiusLimits() {
    const width = parseInt(document.getElementById('double_ring_width')?.value, 10);
    const height = parseInt(document.getElementById('double_ring_height')?.value, 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const maxRadius = Math.max(2, Math.floor(Math.min(width, height) / 2));
    const innerInput = document.getElementById('double_ring_inner_radius');
    const outerInput = document.getElementById('double_ring_outer_radius');
    const innerSlider = document.getElementById('double_ring_inner_radius_slider');
    const outerSlider = document.getElementById('double_ring_outer_radius_slider');
    if (innerInput) innerInput.max = Math.max(2, maxRadius - 1);
    if (innerSlider) innerSlider.max = Math.max(2, maxRadius - 1);
    if (outerInput) outerInput.max = maxRadius;
    if (outerSlider) outerSlider.max = maxRadius;
    if (outerInput && parseFloat(outerInput.value) > maxRadius) outerInput.value = maxRadius;
    if (innerInput && parseFloat(innerInput.value) >= maxRadius) innerInput.value = Math.max(2, maxRadius - 1);

    ['double_ring_inner_width', 'double_ring_outer_width'].forEach(id => {
        const input = document.getElementById(id);
        const slider = document.getElementById(`${id}_slider`);
        if (input) input.max = maxRadius;
        if (slider) slider.max = maxRadius;
        if (input && parseFloat(input.value) > maxRadius) input.value = maxRadius;
    });
    syncDoubleRingSliders();
}

function syncDoubleRingSliders() {
    [
        ['double_ring_inner_radius', 'double_ring_inner_radius_slider'],
        ['double_ring_outer_radius', 'double_ring_outer_radius_slider'],
        ['double_ring_inner_width', 'double_ring_inner_width_slider'],
        ['double_ring_outer_width', 'double_ring_outer_width_slider'],
        ['double_ring_inner_intensity', 'double_ring_inner_intensity_slider'],
        ['double_ring_outer_intensity', 'double_ring_outer_intensity_slider'],
        ['double_ring_between_intensity', 'double_ring_between_intensity_slider']
    ].forEach(([inputId, sliderId]) => {
        const input = document.getElementById(inputId);
        const slider = document.getElementById(sliderId);
        if (input && slider) slider.value = input.value;
    });
}

// ==================== 时间更新 ====================
function updateTime() {
    const now = new Date();
    document.getElementById('current_time').textContent = now.toLocaleTimeString('zh-CN');
}

// ==================== 滑块初始化 ====================
function initializeSliders() {
    const sliders = [
        { input: 'focus_mm', slider: 'focus_slider' },
        { input: 'rotation_degree', slider: 'rotation_slider' }
    ];

    sliders.forEach(({ input, slider }) => {
        const inputEl = document.getElementById(input);
        const sliderEl = document.getElementById(slider);

        if (inputEl && sliderEl) {
            inputEl.addEventListener('input', () => {
                sliderEl.value = inputEl.value;
            });
            sliderEl.addEventListener('input', () => {
                inputEl.value = sliderEl.value;
            });
        }
    });
}

// ==================== 拖拽上传 ====================
function initializeDragDrop() {
    const dropZone = document.getElementById('drop_zone');
    const fileInput = document.getElementById('input_image');

    if (!dropZone || !fileInput) return;

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--primary-color)';
        dropZone.style.background = '#f0f8ff';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '';
        dropZone.style.background = '';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '';
        dropZone.style.background = '';

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleImageUpload(files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleImageUpload(e.target.files[0]);
        }
    });
}

function handleImageUpload(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        AppState.uploadedImage = e.target.result;

        const preview = document.getElementById('image_preview');
        const previewImg = document.getElementById('preview_img');
        const dropZone = document.getElementById('drop_zone');

        if (preview && previewImg && dropZone) {
            previewImg.src = e.target.result;
            preview.style.display = 'block';
            dropZone.style.display = 'none';
        }
    };
    reader.readAsDataURL(file);
}

function removeImage() {
    AppState.uploadedImage = null;

    const preview = document.getElementById('image_preview');
    const dropZone = document.getElementById('drop_zone');

    if (preview && dropZone) {
        preview.style.display = 'none';
        dropZone.style.display = 'block';
    }

    const fileInput = document.getElementById('input_image');
    if (fileInput) fileInput.value = '';
}

// ==================== 波长设置 ====================
function setWavelength(value) {
    const wavelengthInput = document.getElementById('wavelength_nm');
    if (wavelengthInput) {
        wavelengthInput.value = value;
    }

    // 更新按钮状态
    document.querySelectorAll('.wl-preset').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-wl') == value) {
            btn.classList.add('active');
        }
    });
}

// ==================== 生成菲涅尔透镜 ====================
async function generateFresnel() {
    if (!beginGeneration()) return;
    AppState.currentPatternType = 'fresnel';

    const params = {
        focus_mm: parseFloat(document.getElementById('focus_mm').value),
        wavelength_nm: parseFloat(document.getElementById('wavelength_nm').value),
        x_pixels: parseInt(document.getElementById('x_pixels').value),
        y_pixels: parseInt(document.getElementById('y_pixels').value),
        pitch_mode: parseInt(document.getElementById('pitch_mode').value),
        rotation_degree: parseFloat(document.getElementById('rotation_degree').value),
        scale_factor: parseFloat(document.getElementById('scale_factor').value) || 1.0,
        offset_x: parseInt(document.getElementById('offset_x').value) || 0,
        offset_y: parseInt(document.getElementById('offset_y').value) || 0,
        input_image: AppState.uploadedImage
    };

    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const data = await response.json();

        if (data.success) {
            displayPhaseImage(data.image);
            updateParamInfo(params);
            AppState.currentImageData = data;
            document.getElementById('download_btn').disabled = false;
            showNotification('相位图生成成功', 'success');
            addToHistory(params);
        } else {
            throw new Error(data.error || '生成失败');
        }
    } catch (error) {
        console.error('生成错误:', error);
        showNotification('生成失败: ' + error.message, 'error');
    } finally {
        endGeneration();
    }
}

// ==================== 通用图案生成函数 ====================
async function generatePattern(patternType) {
    if (!beginGeneration()) return;
    AppState.currentPatternType = patternType;

    // 构建参数
    let params = {};

    switch (patternType) {
        case 'fresnel':
            params = {
                focal_length: parseFloat(document.getElementById('focus_mm').value),
                wavelength: parseFloat(document.getElementById('wavelength_nm').value),
                width: parseInt(document.getElementById('x_pixels').value),
                height: parseInt(document.getElementById('y_pixels').value)
            };
            break;

        case 'fresnel_three_spots':
            params = {
                focal_length: parseFloat(document.getElementById('three_spot_focus').value),
                wavelength: parseFloat(document.getElementById('three_spot_wavelength').value),
                spot_spacing: parseFloat(document.getElementById('three_spot_spacing').value),
                spot_count: parseInt(document.getElementById('three_spot_count').value),
                pixel_size_um: parseFloat(document.getElementById('three_spot_pixel_size').value),
                algorithm: document.getElementById('three_spot_algorithm').value,
                incident_beam_diameter_mm: parseFloat(document.getElementById('three_spot_beam_diameter').value),
                spot_radius_mm: optionalNumber('three_spot_radius'),
                iterations: parseInt(document.getElementById('three_spot_iterations').value),
                phase_direction: document.getElementById('three_spot_phase_direction').value,
                width: parseInt(document.getElementById('three_spot_width').value),
                height: parseInt(document.getElementById('three_spot_height').value)
            };
            if (isSpotArrayCustomized()) {
                const issue = validateSpotArray();
                if (issue) {
                    endGeneration();
                    setSpotArrayStatus(issue, true);
                    showNotification(issue, 'warning');
                    return;
                }
                params.target_spots = getSpotArrayPayload();
                params.spot_count = params.target_spots.length;
                params.algorithm = 'gaussian_wgs';
                params.legacy_algorithm = SpotArrayState.legacyAlgorithm || 'uniform_grating';
            }
            break;

        case 'three_spots':
            params = {
                focal_length: parseFloat(document.getElementById('tsn_focus').value),
                wavelength: parseFloat(document.getElementById('tsn_wavelength').value),
                spot_spacing: parseFloat(document.getElementById('tsn_spacing').value),
                spot_count: parseInt(document.getElementById('tsn_count').value),
                pixel_size_um: parseFloat(document.getElementById('tsn_pixel_size').value),
                algorithm: document.getElementById('tsn_algorithm').value,
                incident_beam_diameter_mm: parseFloat(document.getElementById('tsn_beam_diameter').value),
                spot_radius_mm: optionalNumber('tsn_spot_radius'),
                iterations: parseInt(document.getElementById('tsn_iterations').value),
                phase_direction: document.getElementById('tsn_phase_direction').value,
                width: parseInt(document.getElementById('tsn_width').value),
                height: parseInt(document.getElementById('tsn_height').value)
            };
            break;

        case 'axicon':
            params = {
                radius: parseFloat(document.getElementById('axicon_radius').value),
                width: parseInt(document.getElementById('axicon_width').value),
                height: parseInt(document.getElementById('axicon_height').value)
            };
            break;

        case 'cylindrical':
            params = {
                focal_length: parseFloat(document.getElementById('cylindrical_focal_length').value),
                wavelength: parseFloat(document.getElementById('cylindrical_wavelength').value),
                pixel_size: parseFloat(document.getElementById('cylindrical_pixel_size').value) / 1000,
                angle: parseFloat(document.getElementById('cylindrical_angle').value),
                width: parseInt(document.getElementById('cylindrical_width').value),
                height: parseInt(document.getElementById('cylindrical_height').value)
            };
            break;

        case 'blaze':
            params = {
                period: parseInt(document.getElementById('blaze_period').value),
                angle: parseFloat(document.getElementById('blaze_angle').value),
                width: parseInt(document.getElementById('blaze_width').value),
                height: parseInt(document.getElementById('blaze_height').value)
            };
            break;

        case 'sine':
            params = {
                period: parseInt(document.getElementById('sine_period').value),
                angle: parseFloat(document.getElementById('sine_angle').value),
                width: parseInt(document.getElementById('sine_width').value),
                height: parseInt(document.getElementById('sine_height').value)
            };
            break;

        case 'vortex':
            params = {
                lnumber: parseInt(document.getElementById('vortex_lnumber').value),
                width: parseInt(document.getElementById('vortex_width').value),
                height: parseInt(document.getElementById('vortex_height').value)
            };
            break;

        case 'random':
            const seedInput = document.getElementById('random_seed').value;
            params = {
                seed: seedInput ? parseInt(seedInput) : null,
                width: parseInt(document.getElementById('random_width').value),
                height: parseInt(document.getElementById('random_height').value)
            };
            break;

        case 'divide':
            params = {
                grayvalue1: parseInt(document.getElementById('divide_gray1').value),
                grayvalue2: parseInt(document.getElementById('divide_gray2').value),
                width: parseInt(document.getElementById('divide_width').value),
                height: parseInt(document.getElementById('divide_height').value)
            };
            break;

        case 'cross':
            const intersectionValue = document.getElementById('cross_intersection_phase').value;
            params = {
                background_phase: parseFloat(document.getElementById('cross_background_phase').value),
                stripe_phase: parseFloat(document.getElementById('cross_stripe_phase').value),
                stripe_width: parseInt(document.getElementById('cross_stripe_width').value),
                stripe_spacing: parseInt(document.getElementById('cross_stripe_spacing').value),
                stripe_number: parseInt(document.getElementById('cross_stripe_number').value),
                width: parseInt(document.getElementById('cross_width').value),
                height: parseInt(document.getElementById('cross_height').value)
            };
            if (intersectionValue !== '' && intersectionValue !== null) {
                params.intersection_phase = parseFloat(intersectionValue);
            }
            break;

        case 'double_ring':
            params = getDoubleRingParams();
            break;

        default:
            showNotification('不支持的图案类型: ' + patternType, 'error');
            endGeneration();
            return;
    }

    try {
        const response = await fetch(`/api/generate/${patternType}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const data = await response.json();

        if (data.success) {
            displayPhaseImage(data.image);
            updateParamInfo(params);
            AppState.currentImageData = data;

            // 启用对应模块的下载按钮
            const downloadBtnId = patternType === 'fresnel' ? 'download_btn' : `${patternType}_download_btn`;
            const downloadBtn = document.getElementById(downloadBtnId);
            if (downloadBtn) downloadBtn.disabled = false;

            const patternLabel = patternType === 'fresnel_three_spots'
                ? '多点聚焦'
                : patternType === 'three_spots'
                    ? '三点聚焦（无透镜）'
                    : patternType;
            showNotification(`${patternLabel} 相位图生成成功`, 'success');
            addToHistory(params);
        } else {
            throw new Error(data.error || '生成失败');
        }
    } catch (error) {
        console.error('生成错误:', error);
        showNotification('生成失败: ' + error.message, 'error');
    } finally {
        endGeneration();
    }
}

function addCurrentToSequence() {
    addToSequence();
}

function getDoubleRingParams() {
    const value = id => parseFloat(document.getElementById(id).value);
    return {
        width: parseInt(document.getElementById('double_ring_width').value),
        height: parseInt(document.getElementById('double_ring_height').value),
        inner_radius: value('double_ring_inner_radius'),
        outer_radius: value('double_ring_outer_radius'),
        inner_width: value('double_ring_inner_width'),
        outer_width: value('double_ring_outer_width'),
        inner_intensity: value('double_ring_inner_intensity'),
        outer_intensity: value('double_ring_outer_intensity'),
        between_intensity: value('double_ring_between_intensity'),
        iterations: parseInt(document.getElementById('double_ring_iterations').value),
        seed: 2026
    };
}

function renderDoubleRingTargetPreview() {
    const targetImg = document.getElementById('double_ring_target_image');
    const placeholder = document.getElementById('double_ring_target_placeholder');
    if (!targetImg) return;

    const params = getDoubleRingParams();
    const width = Math.max(64, Math.min(parseInt(params.width, 10) || 512, 512));
    const height = Math.max(64, Math.min(parseInt(params.height, 10) || 512, 512));
    const inner = Number(params.inner_radius);
    const outer = Number(params.outer_radius);
    if (!Number.isFinite(inner) || !Number.isFinite(outer) || inner <= 0 || outer <= inner) {
        targetImg.style.display = 'none';
        if (placeholder) {
            placeholder.textContent = '请将内圈半径设为小于外圈半径';
            placeholder.style.display = 'block';
        }
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(width, height);
    const innerIntensity = Math.max(0, Math.min(1, Number(params.inner_intensity) || 0));
    const outerIntensity = Math.max(0, Math.min(1, Number(params.outer_intensity) || 0));
    const betweenIntensity = Math.max(0, Math.min(1, Number(params.between_intensity) || 0));
    const innerWidth = Math.max(0.5, Number(params.inner_width) || inner / 2);
    const outerWidth = Math.max(0.5, Number(params.outer_width) || 10);
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const sx = width / Math.max(1, Number(params.width) || width);
    const sy = height / Math.max(1, Number(params.height) || height);
    const scale = Math.min(sx, sy);
    const innerPx = inner * scale;
    const outerPx = outer * scale;
    const innerWidthPx = Math.max(innerWidth * scale, 0.5);
    const outerWidthPx = Math.max(outerWidth * scale, 0.5);
    const innerGateEdge = Math.max(innerWidthPx * 0.15, 0.75);
    let maxValue = 0;
    const values = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const radius = Math.hypot(x - cx, y - cy);
            const inAperture = radius <= outerPx;
            const innerGate = 1 / (1 + Math.exp((radius - innerPx) / innerGateEdge));
            const innerShape = Math.exp(-0.5 * (radius / innerWidthPx) ** 2) * innerGate;
            const outerShape = Math.exp(-0.5 * ((radius - outerPx) / outerWidthPx) ** 2);
            const value = inAperture
                ? Math.max(0, betweenIntensity
                    + (innerIntensity - betweenIntensity) * innerShape
                    + (outerIntensity - betweenIntensity) * outerShape)
                : 0;
            const index = y * width + x;
            values[index] = value;
            maxValue = Math.max(maxValue, value);
        }
    }
    for (let i = 0; i < values.length; i++) {
        const gray = Math.round((values[i] / Math.max(maxValue, 1e-9)) * 255);
        const index = i * 4;
        pixels.data[index] = gray;
        pixels.data[index + 1] = gray;
        pixels.data[index + 2] = gray;
        pixels.data[index + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    targetImg.src = canvas.toDataURL('image/png');
    targetImg.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
}

let doubleRingPreviewTimer = null;
let doubleRingRequestSerial = 0;
function scheduleDoubleRingPreview() {
    renderDoubleRingTargetPreview();
    const status = document.getElementById('double_ring_status');
    if (status) status.textContent = '正在更新预览...';
    clearTimeout(doubleRingPreviewTimer);
    doubleRingPreviewTimer = setTimeout(() => generateDoubleRing(false), 280);
}

async function generateDoubleRing(manual = true) {
    const requestSerial = ++doubleRingRequestSerial;
    const params = getDoubleRingParams();
    const inner = params.inner_radius;
    const outer = params.outer_radius;
    if (!Number.isFinite(inner) || !Number.isFinite(outer) || inner >= outer) {
        const status = document.getElementById('double_ring_status');
        if (status) status.textContent = '内圈半径必须小于外圈半径';
        showNotification('内圈半径必须小于外圈半径', 'error');
        return;
    }
    const phasePlaceholder = document.getElementById('double_ring_phase_placeholder');
    if (phasePlaceholder) phasePlaceholder.textContent = '正在生成...';
    try {
        const response = await fetch('/api/generate/double_ring', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...params, preview: !manual })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'Generation failed');
        if (requestSerial !== doubleRingRequestSerial) return;
        AppState.currentPatternType = 'double_ring';
        AppState.currentImageData = {
            image: data.image,
            filename: data.filename || null,
            filepath: data.filepath || null
        };
        const phaseImg = document.getElementById('double_ring_phase_image');
        const targetImg = document.getElementById('double_ring_target_image');
        const regeneratedImg = document.getElementById('double_ring_regenerated_image');
        if (phaseImg) { phaseImg.src = data.image; phaseImg.style.display = 'block'; }
        if (targetImg && data.target_image) { targetImg.src = data.target_image; targetImg.style.display = 'block'; }
        if (regeneratedImg && data.reconstructed_image) { regeneratedImg.src = data.reconstructed_image; regeneratedImg.style.display = 'block'; }
        ['double_ring_phase_placeholder', 'double_ring_target_placeholder', 'double_ring_regenerated_placeholder'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        displayPhaseImage(data.image);
        const downloadBtn = document.getElementById('double_ring_download_btn');
        if (downloadBtn) downloadBtn.disabled = !data.filename;
        const status = document.getElementById('double_ring_status');
        if (status) status.textContent = `已更新 ${new Date().toLocaleTimeString('zh-CN')}`;
        updateParamInfo(params);
        if (manual) { addToHistory(params); showNotification('双环相位图生成成功', 'success'); }
    } catch (error) {
        if (requestSerial !== doubleRingRequestSerial) return;
        const status = document.getElementById('double_ring_status');
        if (status) status.textContent = error.message;
        if (manual) showNotification('双环相位图生成失败: ' + error.message, 'error');
    }
}

function showCurrentOnSLM() {
    showOnSLM();
}

function downloadCurrentImage() {
    downloadImage();
}

function displayPhaseImage(imageData) {
    const img = document.getElementById('phase_image');
    const placeholder = document.querySelector('.placeholder');
    const canvas = document.getElementById('phase_canvas');

    if (img && placeholder) {
        img.src = imageData;
        img.style.display = 'block';
        placeholder.style.display = 'none';

        // 更新相位分布曲线
        updatePhaseProfile(imageData);
    }
}

function updatePhaseProfile(imageData) {
    const canvas = document.getElementById('profile_canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const img = new Image();
    img.onload = function() {
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        tempCtx.drawImage(img, 0, 0);

        const centerY = Math.floor(img.height / 2);
        const imageDataObj = tempCtx.getImageData(0, centerY, img.width, 1);
        const pixels = imageDataObj.data;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#0066cc';
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let x = 0; x < img.width; x++) {
            const grayValue = pixels[x * 4];
            const canvasX = (x / img.width) * canvas.width;
            const canvasY = canvas.height - (grayValue / 255) * canvas.height;

            if (x === 0) {
                ctx.moveTo(canvasX, canvasY);
            } else {
                ctx.lineTo(canvasX, canvasY);
            }
        }

        ctx.stroke();
    };
    img.src = imageData;
}

function updateParamInfo(params) {
    const type = AppState.currentPatternType || 'fresnel';

    if (type === 'fresnel' || type === 'fresnel_three_spots' || type === 'three_spots') {
        document.getElementById('info_focus').textContent = (params.focus_mm || params.focal_length) + ' mm';
        document.getElementById('info_wavelength').textContent = (params.wavelength_nm || params.wavelength) + ' nm';
    } else {
        document.getElementById('info_focus').textContent = type.toUpperCase();
        document.getElementById('info_wavelength').textContent = 'N/A';
    }

    const width = params.x_pixels || params.width || '-';
    const height = params.y_pixels || params.height || '-';
    document.getElementById('info_resolution').textContent = width + ' × ' + height;
    document.getElementById('info_time').textContent = new Date().toLocaleTimeString('zh-CN');
}

// ==================== 序列管理 ====================
function addToSequence() {
    if (!AppState.currentImageData) {
        showNotification('请先生成相位图', 'warning');
        return;
    }

    const sequenceItem = {
        id: Date.now(),
        image: AppState.currentImageData.image,
        patternType: AppState.currentPatternType,
        filename: AppState.currentImageData.filename,
        params: AppState.currentImageData.paramsDescription || getCurrentParamsDescription()
    };

    AppState.sequenceList.push(sequenceItem);
    updateSequenceList();

    showNotification('已添加到序列', 'success');
}

function getCurrentParamsDescription() {
    const type = AppState.currentPatternType;

    switch (type) {
        case 'fresnel':
            return `f=${document.getElementById('focus_mm').value}mm, λ=${document.getElementById('wavelength_nm').value}nm`;
        case 'fresnel_three_spots':
            if (isSpotArrayCustomized()) {
                return `${getSpotArrayPayload().length} 点 · 二维独立阵列`;
            }
            return `${document.getElementById('three_spot_count').value}点, f=${document.getElementById('three_spot_focus').value}mm, d=${document.getElementById('three_spot_spacing').value}mm`;
        case 'three_spots':
            return `${document.getElementById('tsn_count').value}点, f=${document.getElementById('tsn_focus').value}mm, d=${document.getElementById('tsn_spacing').value}mm, 无透镜`;
        case 'axicon':
            return `r=${document.getElementById('axicon_radius').value}px`;
        case 'blaze':
            return `p=${document.getElementById('blaze_period').value}, θ=${document.getElementById('blaze_angle').value}°`;
        case 'sine':
            return `p=${document.getElementById('sine_period').value}, θ=${document.getElementById('sine_angle').value}°`;
        case 'vortex':
            return `l=${document.getElementById('vortex_lnumber').value}`;
        case 'random':
            return 'random pattern';
        case 'divide':
            return `g=${document.getElementById('divide_gray1').value}/${document.getElementById('divide_gray2').value}`;
        case 'cgh':
            return 'CGH pattern';
        case 'double_ring':
            return `Rin=${document.getElementById('double_ring_inner_radius').value}px, Rmax=${document.getElementById('double_ring_outer_radius').value}px, win=${document.getElementById('double_ring_inner_width').value}px, wout=${document.getElementById('double_ring_outer_width').value}px`;
        default:
            return 'custom pattern';
    }
}

function updateSequenceList() {
    const listEl = document.getElementById('sequence_list');
    listEl.replaceChildren();

    if (AppState.sequenceList.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sequence-empty';
        const message = document.createElement('p');
        message.textContent = '暂无序列，请添加图案';
        empty.append(message);
        listEl.append(empty);
        return;
    }

    AppState.sequenceList.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'sequence-item';
        row.dataset.id = String(item.id);
        const order = document.createElement('span');
        order.className = 'seq-index';
        order.textContent = `#${index + 1}`;
        const details = document.createElement('span');
        details.className = 'seq-params';
        details.textContent = `${item.patternType || 'pattern'}: ${item.params || ''}${item.paintAnimation ? ` · ${item.paintAnimation.frameCount} 帧` : ''}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-remove-seq';
        remove.textContent = '✖';
        remove.title = '从序列移除';
        remove.setAttribute('aria-label', '从序列移除');
        remove.addEventListener('click', () => removeFromSequence(item.id));
        row.append(order, details, remove);
        listEl.append(row);
    });
}

function removeFromSequence(id) {
    AppState.sequenceList = AppState.sequenceList.filter(item => item.id !== id);
    if (AppState.isPlaying || AppState.sequenceIndex > 0) stopSequence();
    else AppState.sequenceIndex = 0;
    updateSequenceList();
}

function getSequenceFrameCount(item) {
    return item?.paintAnimation?.frameCount || 1;
}

function getSequenceTotalFrames() {
    return AppState.sequenceList.reduce((total, item) => total + getSequenceFrameCount(item), 0);
}

function resolveSequenceFrame(index) {
    let offset = 0;
    for (const item of AppState.sequenceList) {
        const frameCount = getSequenceFrameCount(item);
        if (index < offset + frameCount) {
            return { item, frameIndex: index - offset };
        }
        offset += frameCount;
    }
    return null;
}

function playSequence() {
    if (AppState.sequenceList.length === 0) {
        showNotification('序列为空，请先添加图案', 'warning');
        return;
    }
    if (AppState.playInterval) return;

    AppState.isPlaying = true;
    const totalFrames = getSequenceTotalFrames();
    if (AppState.sequenceIndex >= totalFrames) AppState.sequenceIndex = 0;

    const interval = Math.max(100, parseInt(document.getElementById('play_interval').value, 10) || 1000);
    const loop = document.getElementById('loop_play').checked;

    const advanceSequence = () => {
        if (AppState.sequenceIndex >= totalFrames) {
            if (loop) {
                AppState.sequenceIndex = 0;
            } else {
                stopSequence();
                return;
            }
        }

        const frame = resolveSequenceFrame(AppState.sequenceIndex);
        if (!frame) {
            stopSequence();
            return;
        }
        const image = frame.item.paintAnimation
            ? renderPaintBoardSequenceFrame(frame.item, frame.frameIndex)
            : frame.item.image;
        displayPhaseImage(image);
        AppState.sequenceIndex++;

        document.getElementById('play_btn').disabled = true;
        document.getElementById('pause_btn').disabled = false;
    };
    advanceSequence();
    AppState.playInterval = setInterval(advanceSequence, interval);

    showNotification('序列播放已开始', 'info');
}

function pauseSequence() {
    if (AppState.playInterval) {
        clearInterval(AppState.playInterval);
        AppState.playInterval = null;
        AppState.isPlaying = false;

        document.getElementById('play_btn').disabled = false;
        document.getElementById('pause_btn').disabled = true;

        showNotification('序列播放已暂停', 'info');
    }
}

function stopSequence() {
    if (AppState.playInterval) {
        clearInterval(AppState.playInterval);
        AppState.playInterval = null;
    }
    const wasPlaying = AppState.isPlaying;
    AppState.isPlaying = false;
    AppState.sequenceIndex = 0;
    document.getElementById('play_btn').disabled = false;
    document.getElementById('pause_btn').disabled = true;
    if (wasPlaying) showNotification('序列播放已停止', 'info');
}

// ==================== 设备连接 ====================
function connectDevice() {
    AppState.deviceConnected = true;

    const statusEl = document.getElementById('device_status');
    statusEl.innerHTML = `
        <span class="status-icon">✅</span>
        <span class="status-text">模拟已连接</span>
    `;

    document.getElementById('device_name').textContent = '模拟设备 · LCOS-SLM X15223';

    showNotification('模拟设备已连接；尚未连接真实 SLM', 'info');
}

// ==================== 显示到SLM ====================
function showOnSLM() {
    if (!AppState.currentImageData) {
        showNotification('请先生成相位图', 'warning');
        return;
    }

    if (!AppState.deviceConnected) {
        showNotification('请先连接SLM设备', 'warning');
        return;
    }

    showNotification('模拟显示完成；相位图未发送到真实 SLM', 'info');
}

// ==================== 下载图像 ====================
function downloadImage() {
    if (AppState.currentImageData && AppState.currentImageData.filename) {
        const link = document.createElement('a');
        link.href = `/api/download/${encodeURIComponent(AppState.currentImageData.filename)}`;
        link.download = AppState.currentImageData.filename;
        link.click();
        showNotification('8-bit BMP 图像下载已开始', 'success');
    } else {
        showNotification('请先生成相位图', 'warning');
    }
}

// ==================== 工具函数 ====================
function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
}

function beginGeneration() {
    if (AppState.generationInProgress) {
        showNotification('正在生成，请稍候', 'warning');
        return false;
    }
    AppState.generationInProgress = true;
    showLoading(true);
    return true;
}

function endGeneration() {
    AppState.generationInProgress = false;
    showLoading(false);
}

function resetModule(moduleId) {
    switch (moduleId) {
        case 'double-ring':
            document.getElementById('double_ring_inner_radius').value = 16;
            document.getElementById('double_ring_outer_radius').value = 50;
            document.getElementById('double_ring_inner_width').value = 8;
            document.getElementById('double_ring_outer_width').value = 10;
            document.getElementById('double_ring_inner_intensity').value = 0.7;
            document.getElementById('double_ring_outer_intensity').value = 1.0;
            document.getElementById('double_ring_between_intensity').value = 0.2;
            document.getElementById('double_ring_iterations').value = 100;
            document.getElementById('double_ring_width').value = 512;
            document.getElementById('double_ring_height').value = 512;
            updateDoubleRingRadiusLimits();
            syncDoubleRingSliders();
            scheduleDoubleRingPreview();
            showNotification('Double-ring parameters reset', 'info');
            break;

        case 'fresnel':
            document.getElementById('focus_mm').value = 1000;
            document.getElementById('wavelength_nm').value = 532;
            document.getElementById('rotation_degree').value = 0;
            document.getElementById('scale_factor').value = 1.0;
            document.getElementById('offset_x').value = 0;
            document.getElementById('offset_y').value = 0;
            document.getElementById('x_pixels').value = 1272;
            document.getElementById('y_pixels').value = 1024;
            showNotification('菲涅尔透镜参数已重置', 'info');
            break;

        case 'fresnel-three-spots':
            document.getElementById('three_spot_focus').value = 1000;
            document.getElementById('three_spot_wavelength').value = 532;
            document.getElementById('three_spot_spacing').value = 1.0;
            document.getElementById('three_spot_count').value = 3;
            document.getElementById('three_spot_pixel_size').value = 12.5;
            document.getElementById('three_spot_algorithm').value = 'uniform_grating';
            document.getElementById('three_spot_beam_diameter').value = 10.0;
            document.getElementById('three_spot_radius').value = '';
            document.getElementById('three_spot_iterations').value = 30;
            document.getElementById('three_spot_phase_direction').value = 'standard';
            document.getElementById('three_spot_width').value = 1272;
            document.getElementById('three_spot_height').value = 1024;
            if (typeof resetSpotArray === 'function') resetSpotArray();
            document.getElementById('three_spot_algorithm').value = 'uniform_grating';
            toggleThreeSpotOptimization();
            showNotification('多点聚焦参数已重置', 'info');
            break;

        case 'three-spots-no-lens':
            document.getElementById('tsn_focus').value = 1000;
            document.getElementById('tsn_wavelength').value = 532;
            document.getElementById('tsn_spacing').value = 1.0;
            document.getElementById('tsn_count').value = 3;
            document.getElementById('tsn_pixel_size').value = 12.5;
            document.getElementById('tsn_algorithm').value = 'uniform_grating';
            document.getElementById('tsn_beam_diameter').value = 10.0;
            document.getElementById('tsn_spot_radius').value = '';
            document.getElementById('tsn_iterations').value = 30;
            document.getElementById('tsn_phase_direction').value = 'standard';
            document.getElementById('tsn_width').value = 1272;
            document.getElementById('tsn_height').value = 1024;
            toggleThreeSpotOptimization('tsn');
            showNotification('三点聚焦（无透镜）参数已重置', 'info');
            break;

        case 'axicon':
            document.getElementById('axicon_radius').value = 100;
            document.getElementById('axicon_width').value = 512;
            document.getElementById('axicon_height').value = 512;
            showNotification('轴棱锥透镜参数已重置', 'info');
            break;

        case 'cylindrical':
            document.getElementById('cylindrical_focal_length').value = 1000;
            document.getElementById('cylindrical_wavelength').value = 532;
            document.getElementById('cylindrical_pixel_size').value = 12.5;
            document.getElementById('cylindrical_beam_diameter').value = 10.0;
            document.getElementById('cylindrical_angle').value = 0;
            document.getElementById('cylindrical_width').value = 1272;
            document.getElementById('cylindrical_height').value = 1024;
            updateCylindricalDiag();
            showNotification('柱面透镜参数已重置', 'info');
            break;

        case 'blaze':
            document.getElementById('blaze_period').value = 50;
            document.getElementById('blaze_angle').value = 0;
            document.getElementById('blaze_width').value = 512;
            document.getElementById('blaze_height').value = 512;
            showNotification('闪耀光栅参数已重置', 'info');
            break;

        case 'sine':
            document.getElementById('sine_period').value = 50;
            document.getElementById('sine_angle').value = 0;
            document.getElementById('sine_width').value = 512;
            document.getElementById('sine_height').value = 512;
            showNotification('正弦光栅参数已重置', 'info');
            break;

        case 'vortex':
            document.getElementById('vortex_lnumber').value = 1;
            document.getElementById('vortex_width').value = 512;
            document.getElementById('vortex_height').value = 512;
            showNotification('涡旋光束参数已重置', 'info');
            break;

        case 'random':
            document.getElementById('random_seed').value = '';
            document.getElementById('random_width').value = 512;
            document.getElementById('random_height').value = 512;
            showNotification('随机散斑参数已重置', 'info');
            break;

        case 'divide':
            document.getElementById('divide_gray1').value = 0;
            document.getElementById('divide_gray2').value = 255;
            document.getElementById('divide_width').value = 1272;
            document.getElementById('divide_height').value = 1024;
            showNotification('分屏图案参数已重置', 'info');
            break;

        case 'cgh-simulation':
            document.getElementById('cgh_repetition').value = 100;
            document.getElementById('cgh_light_shape').value = 'gaussian';
            document.getElementById('cgh_light_size').value = 10;
            document.getElementById('cgh_algorithm').value = 'gs';
            document.getElementById('cgh_width').value = 256;
            document.getElementById('cgh_height').value = 256;
            showNotification('CGH参数已重置', 'info');
            break;

        default:
            showNotification('未知模块', 'warning');
    }
}

// ==================== CGH Simulation ====================
function initializeCGHUpload() {
    const cghInput = document.getElementById('cgh_input_image');
    const cghPath = document.getElementById('cgh_target_path');

    if (!cghInput || !cghPath) return;

    cghInput.addEventListener('change', function(e) {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            cghPath.value = file.name;

            const reader = new FileReader();
            reader.onload = function(e) {
                setCGHTargetImage(e.target.result, file.name);
            };
            reader.readAsDataURL(file);
        }
    });
}

function setCGHTargetImage(imageSrc, label) {
    AppState.cghData.targetImage = imageSrc;
    document.getElementById('cgh_target_path').value = label;
    displayCGHTargetImage(imageSrc);
    generateLightShapePreview();
}

function initializeCGHShapeHint() {
    const shapeSelect = document.getElementById('cgh_light_shape');
    const sizeHint = document.getElementById('cgh_size_hint');

    if (!shapeSelect || !sizeHint) return;

    const hints = {
        'gaussian': 'Gaussian : diameter(1/e2) /mm',
        'flat-circle': 'Flat-circle : diameter /mm',
        'flat-square': 'Flat-square : side length /mm'
    };

    shapeSelect.addEventListener('change', function() {
        sizeHint.textContent = hints[this.value] || '';
        generateLightShapePreview();
    });

    document.getElementById('cgh_light_size').addEventListener('input', function() {
        generateLightShapePreview();
    });
}

function displayCGHTargetImage(imageSrc) {
    const img = document.getElementById('cgh_target_image');
    const placeholder = document.getElementById('cgh_target_placeholder');

    if (img && placeholder) {
        img.src = imageSrc;
        img.style.display = 'block';
        placeholder.style.display = 'none';
    }
}

function generateLightShapePreview() {
    // 绘制光斑形状预览（简化的2D可视化）
    const shape = document.getElementById('cgh_light_shape').value;
    const size = parseFloat(document.getElementById('cgh_light_size').value) || 10;

    const canvas = document.getElementById('cgh_light_canvas');
    const placeholder = document.getElementById('cgh_light_placeholder');

    if (!canvas || !placeholder) return;

    const size_px = 128;
    canvas.width = size_px;
    canvas.height = size_px;
    canvas.style.display = 'block';
    placeholder.style.display = 'none';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size_px, size_px);

    // 背景
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size_px, size_px);

    const center = size_px / 2;
    const radius = Math.min(size * 3, size_px / 2 - 5);

    if (shape === 'gaussian') {
        const gradient = ctx.createRadialGradient(center, center, 0, center, center, radius);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.3)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(center, center, radius, 0, Math.PI * 2);
        ctx.fill();
    } else if (shape === 'flat-circle') {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(center, center, radius, 0, Math.PI * 2);
        ctx.fill();
    } else if (shape === 'flat-square') {
        ctx.fillStyle = '#fff';
        const side = Math.min(radius * 2, size_px - 10);
        ctx.fillRect(center - side/2, center - side/2, side, side);
    }
}

async function calculateCGH() {
    if (!AppState.cghData.targetImage) {
        showNotification('请先选择目标图像', 'warning');
        return;
    }
    if (!beginGeneration()) return;

    AppState.currentPatternType = 'cgh';

    const gaussianSpotsValue = parseInt(document.getElementById('cgh_gaussian_spots').value);
    const params = {
        target_image: AppState.cghData.targetImage,
        algorithm: document.getElementById('cgh_algorithm').value,
        light_shape: document.getElementById('cgh_light_shape').value,
        light_size: parseFloat(document.getElementById('cgh_light_size').value),
        iterations: parseInt(document.getElementById('cgh_repetition').value),
        width: parseInt(document.getElementById('cgh_width').value),
        height: parseInt(document.getElementById('cgh_height').value),
        gaussian_spots: gaussianSpotsValue === 1,
        spot_radius: parseFloat(document.getElementById('cgh_spot_radius').value)
    };

    try {
        const response = await fetch('/api/cgh/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const data = await response.json();

        if (data.success) {
            // 保存CGH数据
            AppState.cghData.cghImage = data.cgh_image;
            AppState.cghData.regeneratedImage = data.regenerated_image;
            AppState.cghData.lightShapeImage = data.light_shape_image;
            AppState.cghData.filename = data.filename;

            // 同时设置当前图像数据，支持序列和下载
            AppState.currentImageData = {
                image: data.cgh_image,
                filename: data.filename,
                filepath: data.filepath
            };

            // 显示再生图像
            displayRegenerateImage(data.regenerated_image);

            // 如果有处理后的目标图像，显示提示
            if (data.processed_target_image) {
                showNotification(`CGH计算成功（高斯光斑已转换，半径: ${data.info.spot_radius}px）`, 'success');
            } else {
                showNotification('CGH计算成功', 'success');
            }

            // 更新信息
            const gaussianInfo = data.info.gaussian_spots ? ` Gaussian(r=${data.info.spot_radius})` : '';
            document.getElementById('cgh_image_info').innerHTML = `
                ${data.info.width}×${data.info.height}<br>
                ${data.info.iterations} iterations<br>
                ${data.info.algorithm.toUpperCase()} ${data.info.light_shape}${gaussianInfo}
            `;

            // 启用按钮
            document.getElementById('cgh_download_btn').disabled = false;
            document.getElementById('cgh_send_btn').disabled = false;

        } else {
            throw new Error(data.error || 'CGH计算失败');
        }
    } catch (error) {
        console.error('CGH计算错误:', error);
        showNotification('CGH计算失败: ' + error.message, 'error');
    } finally {
        endGeneration();
    }
}

function toggleSpotRadiusInput() {
    const gaussianSpots = document.getElementById('cgh_gaussian_spots').value;
    const spotRadiusContainer = document.getElementById('spot_radius_container');

    if (gaussianSpots === '1') {
        spotRadiusContainer.style.display = 'block';
    } else {
        spotRadiusContainer.style.display = 'none';
    }
}

function toggleThreeSpotOptimization(prefix = 'three_spot') {
    const algorithm = document.getElementById(prefix + '_algorithm');
    const optimization = document.getElementById(prefix + '_optimization_params');
    const iterations = document.getElementById(prefix + '_iterations_container');
    const spotRadius = document.getElementById(prefix + '_spot_radius_container');
    const dammann = document.getElementById(prefix + '_dammann_params');
    const uniform = document.getElementById(prefix + '_uniform_params');
    if (!algorithm || !optimization || !iterations || !dammann || !uniform) return;

    if (prefix === 'three_spot' && typeof isSpotArrayCustomized === 'function' &&
            isSpotArrayCustomized()) {
        algorithm.value = 'gaussian_wgs';
    }

    const spotCount = parseInt(document.getElementById(prefix + '_count').value);
    const dammannOption = algorithm.querySelector('option[value="dammann"]');
    dammannOption.disabled = spotCount !== 3;
    if (algorithm.value === 'dammann' && spotCount !== 3) {
        algorithm.value = 'uniform_grating';
    }

    const targetPreview = document.getElementById(prefix + '_target');
    if (targetPreview && Number.isInteger(spotCount) && spotCount >= 1 && spotCount <= 15) {
        targetPreview.innerHTML = '<span></span>'.repeat(spotCount);
        targetPreview.setAttribute('aria-label', `${spotCount} 个水平等间距焦点`);
    }

    const usesBeamModel = algorithm.value === 'gaussian_wgs' || algorithm.value === 'dammann';
    optimization.style.display = usesBeamModel ? 'block' : 'none';
    iterations.style.display = algorithm.value === 'gaussian_wgs' ? 'block' : 'none';
    if (spotRadius) spotRadius.style.display = algorithm.value === 'gaussian_wgs' ? 'block' : 'none';
    dammann.style.display = algorithm.value === 'dammann' ? 'block' : 'none';
    uniform.style.display = algorithm.value === 'uniform_grating' ? 'block' : 'none';
    updateThreeSpotDammannInfo(prefix);
}

function optionalNumber(id) {
    const value = document.getElementById(id).value.trim();
    return value === '' ? null : parseFloat(value);
}

function initializeThreeSpotDammannInfo(prefix = 'three_spot') {
    [prefix + '_focus', prefix + '_wavelength', prefix + '_spacing',
        prefix + '_pixel_size', prefix + '_width', prefix + '_count']
        .forEach(id => {
            const input = document.getElementById(id);
            if (input) input.addEventListener('input', () => updateThreeSpotDammannInfo(prefix));
        });
}

function updateThreeSpotDammannInfo(prefix = 'three_spot') {
    const output = document.getElementById(prefix + '_dammann_period');
    if (!output) return;
    const focalLength = parseFloat(document.getElementById(prefix + '_focus').value);
    const wavelength = parseFloat(document.getElementById(prefix + '_wavelength').value);
    const spacing = parseFloat(document.getElementById(prefix + '_spacing').value);
    const pixelSize = parseFloat(document.getElementById(prefix + '_pixel_size').value);
    const width = parseInt(document.getElementById(prefix + '_width').value);
    const spotCount = parseInt(document.getElementById(prefix + '_count').value);
    const periodPixels = wavelength * focalLength / (1000 * spacing * pixelSize);
    output.textContent = Number.isFinite(periodPixels)
        ? `${periodPixels.toFixed(2)} 像素 / 周期`
        : '-';

    const outputStep = wavelength * focalLength / (1000 * width * pixelSize);
    let cycles = Math.max(1, Math.round(spacing / outputStep));
    if (spotCount % 2 === 0 && cycles % 2 === 1) {
        const candidates = [cycles - 1, cycles + 1].filter(value => value >= 2);
        cycles = candidates.reduce((best, value) =>
            Math.abs(value * outputStep - spacing) < Math.abs(best * outputStep - spacing)
                ? value : best
        );
    }
    const actualSpacing = cycles * outputStep;
    const uniformPeriod = width / cycles;
    const uniformInfo = document.getElementById(prefix + '_uniform_sampling');
    if (uniformInfo && Number.isFinite(actualSpacing)) {
        uniformInfo.textContent = `${actualSpacing.toFixed(4)} mm；${uniformPeriod.toFixed(2)} 像素 / 周期`;
    }
}

function displayRegenerateImage(imageSrc) {
    const canvas = document.getElementById('cgh_regenerate_canvas');
    const placeholder = document.getElementById('cgh_regenerate_placeholder');

    if (!canvas || !placeholder) return;

    const img = new Image();
    img.onload = function() {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        canvas.style.display = 'block';
        placeholder.style.display = 'none';
    };
    img.src = imageSrc;
}

function downloadCGH() {
    if (AppState.cghData.filename) {
        const link = document.createElement('a');
        link.href = `/api/download/${AppState.cghData.filename}`;
        link.download = AppState.cghData.filename;
        link.click();
        showNotification('8-bit BMP CGH 图像下载已开始', 'success');
    } else {
        showNotification('请先生成CGH', 'warning');
    }
}

function sendCGHToSLM() {
    if (!AppState.cghData.cghImage) {
        showNotification('请先生成CGH', 'warning');
        return;
    }

    if (!AppState.deviceConnected) {
        showNotification('请先连接SLM设备', 'warning');
        return;
    }

    showNotification('CGH 模拟发送完成；图像未发送到真实 SLM', 'info');
}

function loadPatternFromMain() {
    const currentImage = AppState.currentImageData;
    if (!currentImage?.image) {
        showNotification('请先在主预览中生成或加载图案', 'warning');
        return;
    }

    const label = currentImage.filename
        ? `主程序: ${currentImage.filename}`
        : '主程序当前图案';
    setCGHTargetImage(currentImage.image, label);
    showNotification('主预览图案已设为 CGH 目标图像', 'success');
}

async function loadCGHFromMain() {
    const imageData = AppState.cghData.cghImage;
    if (!imageData) {
        showNotification('请先在 CGH 模块中生成相位图', 'warning');
        return;
    }

    try {
        const image = await loadPaintImage(imageData);
        displayPhaseImage(imageData);
        AppState.currentPatternType = 'cgh';
        AppState.currentImageData = {
            image: imageData,
            filename: AppState.cghData.filename || 'cgh-phase.bmp',
            paramsDescription: 'CGH'
        };
        document.getElementById('download_btn').disabled = false;
        document.getElementById('info_focus').textContent = 'CGH';
        document.getElementById('info_wavelength').textContent = 'N/A';
        document.getElementById('info_resolution').textContent =
            image.naturalWidth + ' × ' + image.naturalHeight;
        document.getElementById('info_time').textContent = new Date().toLocaleTimeString('zh-CN');
        showNotification('CGH 相位图已恢复到主预览', 'success');
    } catch (error) {
        showNotification('CGH 相位图加载失败: ' + error.message, 'error');
    }
}

function returnToMain() {
    showModule('fresnel');
    showNotification('已返回主程序', 'info');
}

// ==================== CGH 视频序列播放 ====================
const CGH_VIDEO_MAX_FRAMES = 200;

function initializeCGHVideoUpload() {
    const input = document.getElementById('cgh_video_input');
    if (input) {
        input.addEventListener('change', function(e) {
            handleCGHVideoFiles(e.target.files);
            input.value = '';
        });
    }
    const slider = document.getElementById('cgh_video_slider');
    if (slider) {
        slider.addEventListener('input', function() {
            if (AppState.cghVideo.playing) pauseCGHVideo();
            showCGHVideoFrame(parseInt(this.value, 10) || 0);
        });
    }
    const modeSelect = document.getElementById('cgh_video_display_mode');
    if (modeSelect) {
        modeSelect.addEventListener('change', () => showCGHVideoFrame(AppState.cghVideo.index));
    }
}

function handleCGHVideoFiles(fileList) {
    const files = Array.from(fileList || []).filter(file => file.type.startsWith('image/'));
    if (!files.length) {
        showNotification('请选择图像文件', 'warning');
        return;
    }
    const remaining = CGH_VIDEO_MAX_FRAMES - AppState.cghVideo.frames.length;
    if (remaining <= 0) {
        showNotification(`视频序列最多支持 ${CGH_VIDEO_MAX_FRAMES} 帧`, 'warning');
        return;
    }
    const accepted = files.slice(0, remaining);
    if (accepted.length < files.length) {
        showNotification(`超出帧数上限，仅导入前 ${accepted.length} 张图像`, 'warning');
    }

    let pending = accepted.length;
    const finishOne = () => {
        pending--;
        if (pending === 0) {
            stopCGHVideo();
            renderCGHVideoFrames();
        }
    };
    accepted.forEach(file => {
        const reader = new FileReader();
        reader.onload = () => {
            AppState.cghVideo.frames.push({
                id: Date.now() + Math.random(),
                target: reader.result,
                phase: null,
                regenerated: null,
                filename: '',
                label: file.name
            });
            finishOne();
        };
        reader.onerror = finishOne;
        reader.readAsDataURL(file);
    });
}

function addCurrentCGHToVideo() {
    const cghData = AppState.cghData;
    if (!cghData || !cghData.cghImage) {
        showNotification('请先在 CGH 模块计算相位图', 'warning');
        return;
    }
    if (AppState.cghVideo.frames.length >= CGH_VIDEO_MAX_FRAMES) {
        showNotification(`视频序列最多支持 ${CGH_VIDEO_MAX_FRAMES} 帧`, 'warning');
        return;
    }
    AppState.cghVideo.frames.push({
        id: Date.now() + Math.random(),
        target: cghData.targetImage || null,
        phase: cghData.cghImage,
        regenerated: cghData.regeneratedImage || null,
        filename: cghData.filename || '',
        label: cghData.filename ? `当前CGH: ${cghData.filename}` : '当前CGH'
    });
    renderCGHVideoFrames();
    showNotification('已加入当前 CGH 帧序列', 'success');
}

function imageBlobToObjectUrl(blob) {
    if (!window.URL?.createObjectURL) throw new Error('浏览器不支持本地相位帧预览');
    return window.URL.createObjectURL(blob);
}

async function appendMotionJobToCGH(jobId) {
    const statusResponse = await fetch(`/api/spot_motion/jobs/${encodeURIComponent(jobId)}`);
    const status = await statusResponse.json();
    if (!statusResponse.ok || status.status !== 'complete' || !Array.isArray(status.frames)) {
        throw new Error(status.error || '运动任务尚未完整生成');
    }
    if (status.frames.length !== Number(status.frame_count)) {
        throw new Error('运动任务帧列表不完整');
    }
    if (AppState.cghVideo.frames.length + status.frames.length > CGH_VIDEO_MAX_FRAMES) {
        throw new Error(`CGH 视频序列最多支持 ${CGH_VIDEO_MAX_FRAMES} 帧，当前剩余容量不足`);
    }

    const imported = [];
    try {
        for (const [index, frame] of status.frames.entries()) {
            const [phaseResponse, reconstructionResponse] = await Promise.all([
                fetch(frame.phase_url),
                fetch(frame.reconstruction_url)
            ]);
            if (!phaseResponse.ok || !reconstructionResponse.ok) {
                throw new Error(`读取运动帧第 ${index + 1} 帧失败`);
            }
            const [phaseBlob, reconstructionBlob] = await Promise.all([
                phaseResponse.blob(),
                reconstructionResponse.blob()
            ]);
              let phaseUrl = null;
              let reconstructionUrl = null;
              try {
                  phaseUrl = imageBlobToObjectUrl(phaseBlob);
                  reconstructionUrl = imageBlobToObjectUrl(reconstructionBlob);
              } catch (error) {
                  if (phaseUrl && phaseUrl.startsWith('blob:')) {
                      URL.revokeObjectURL(phaseUrl);
                  }
                  throw error;
              }
            imported.push({
                id: Date.now() + Math.random() + index,
                target: null,
                  phase: phaseUrl,
                  regenerated: reconstructionUrl,
                filename: frame.phase_file || `motion_${jobId}_${index + 1}.bmp`,
                label: `帧 ${index + 1}/${status.frames.length} · t=${Number(frame.time_s).toFixed(3)} s`,
                duration_ms: frame.duration_ms,
                time_s: frame.time_s,
                spots: frame.spots,
                source: 'motion',
                source_job_id: jobId
            });
        }
    } catch (error) {
        imported.forEach(frame => [frame.phase, frame.regenerated].forEach(url => URL.revokeObjectURL(url)));
        throw error;
    }

    AppState.cghVideo.frames.push(...imported);
    const displayMode = document.getElementById('cgh_video_display_mode');
    if (displayMode) displayMode.value = 'regenerated';
    stopCGHVideo();
    renderCGHVideoFrames();
    showCGHVideoFrame(AppState.cghVideo.frames.length - imported.length);
    return imported.length;
}

function removeCGHVideoFrame(id) {
    const wasActive = AppState.cghVideo.playing || AppState.cghVideo.index > 0;
    const removed = AppState.cghVideo.frames.find(frame => frame.id === id);
    if (removed?.source === 'motion') {
        [removed.phase, removed.regenerated].forEach(url => {
            if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
        });
    }
    AppState.cghVideo.frames = AppState.cghVideo.frames.filter(frame => frame.id !== id);
    if (wasActive) stopCGHVideo();
    renderCGHVideoFrames();
}

function moveCGHVideoFrame(id, direction) {
    const frames = AppState.cghVideo.frames;
    const index = frames.findIndex(frame => frame.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= frames.length) return;
    [frames[index], frames[target]] = [frames[target], frames[index]];
    renderCGHVideoFrames();
}

function clearCGHVideoFrames() {
    if (!AppState.cghVideo.frames.length) return;
    stopCGHVideo();
    AppState.cghVideo.frames.filter(frame => frame.source === 'motion').forEach(frame => {
        [frame.phase, frame.regenerated].forEach(url => {
            if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
        });
    });
    AppState.cghVideo.frames = [];
    AppState.cghVideo.index = 0;
    renderCGHVideoFrames();
    showNotification('已清空视频序列', 'info');
}

function renderCGHVideoFrames() {
    const listEl = document.getElementById('cgh_video_frames');
    if (listEl) {
        listEl.replaceChildren();

        if (!AppState.cghVideo.frames.length) {
            const empty = document.createElement('div');
            empty.className = 'cgh-video-empty';
            empty.textContent = '暂无帧，请导入目标图或加入当前 CGH';
            listEl.append(empty);
        }

        AppState.cghVideo.frames.forEach((frame, index) => {
            const card = document.createElement('div');
            card.className = 'cgh-video-frame' + (index === AppState.cghVideo.index ? ' active' : '');
            card.title = frame.label || `第 ${index + 1} 帧`;

            const order = document.createElement('span');
            order.className = 'frame-index';
            order.textContent = `#${index + 1}`;

            const thumb = document.createElement('img');
            thumb.alt = `第 ${index + 1} 帧`;
            thumb.src = frame.phase || frame.target || '';

            const state = document.createElement('span');
            state.className = 'frame-state' + (frame.phase ? ' done' : '');
            state.textContent = frame.phase ? '已计算' : '待计算';

            const actions = document.createElement('div');
            actions.className = 'frame-actions';
            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.textContent = '↑';
            upBtn.title = '上移';
            upBtn.disabled = index === 0;
            upBtn.addEventListener('click', e => {
                e.stopPropagation();
                moveCGHVideoFrame(frame.id, -1);
            });
            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.textContent = '↓';
            downBtn.title = '下移';
            downBtn.disabled = index === AppState.cghVideo.frames.length - 1;
            downBtn.addEventListener('click', e => {
                e.stopPropagation();
                moveCGHVideoFrame(frame.id, 1);
            });
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.textContent = '✖';
            removeBtn.title = '移除该帧';
            removeBtn.addEventListener('click', e => {
                e.stopPropagation();
                removeCGHVideoFrame(frame.id);
            });
            actions.append(upBtn, downBtn, removeBtn);

            card.addEventListener('click', () => {
                stopCGHVideo();
                showCGHVideoFrame(index);
            });

            card.append(order, thumb, state, actions);
            listEl.append(card);
        });
    }
    updateCGHVideoControls();
}

function updateCGHVideoControls() {
    const frames = AppState.cghVideo.frames;
    const slider = document.getElementById('cgh_video_slider');
    if (slider) {
        slider.max = String(Math.max(0, frames.length - 1));
        slider.value = String(Math.min(AppState.cghVideo.index, Math.max(0, frames.length - 1)));
        slider.disabled = frames.length === 0;
    }
    const indicator = document.getElementById('cgh_video_frame_indicator');
    if (indicator) {
        indicator.textContent = frames.length
            ? `帧 ${Math.min(AppState.cghVideo.index + 1, frames.length)}/${frames.length}`
            : '帧 0/0';
    }
    const exportBtn = document.getElementById('cgh_video_export_btn');
    if (exportBtn) exportBtn.disabled = !frames.some(frame => frame.phase);
    const calcBtn = document.getElementById('cgh_video_calc_btn');
    if (calcBtn) calcBtn.disabled = AppState.cghVideo.calculating || frames.length === 0;
}

function drawCGHVideoCanvas(canvas, imageSrc) {
    const img = new Image();
    img.onload = function() {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = imageSrc;
}

function showCGHVideoFrame(index) {
    const frames = AppState.cghVideo.frames;
    if (!frames.length) return;
    AppState.cghVideo.index = Math.max(0, Math.min(index, frames.length - 1));
    const frame = frames[AppState.cghVideo.index];
    const modeSelect = document.getElementById('cgh_video_display_mode');
    const mode = modeSelect ? modeSelect.value : 'phase';
    const image = mode === 'regenerated' && frame.regenerated ? frame.regenerated : frame.phase;

    const canvas = document.getElementById('cgh_video_canvas');
    const placeholder = document.getElementById('cgh_video_placeholder');
    if (canvas && placeholder) {
        if (image) {
            drawCGHVideoCanvas(canvas, image);
            canvas.style.display = 'block';
            placeholder.style.display = 'none';
        } else {
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            canvas.style.display = 'none';
            placeholder.style.display = 'block';
        }
    }

    if (frame.phase && mode === 'phase') {
        displayPhaseImage(frame.phase);
    }

    updateCGHVideoControls();
}

function playCGHVideo() {
    const frames = AppState.cghVideo.frames;
    if (!frames.length) {
        showNotification('视频序列为空，请先添加帧', 'warning');
        return;
    }
    if (!frames.some(frame => frame.phase)) {
        showNotification('请先点击"批量计算序列"生成相位图', 'warning');
        return;
    }
    if (AppState.cghVideo.timer) return;

    AppState.cghVideo.playing = true;
    const interval = Math.max(50,
        parseInt(document.getElementById('cgh_video_interval')?.value, 10) || 200);
    const loop = document.getElementById('cgh_video_loop')?.checked ?? true;
    if (AppState.cghVideo.index >= frames.length) AppState.cghVideo.index = 0;

    const advanceCGHVideo = () => {
        if (AppState.cghVideo.index >= frames.length) {
            if (loop) {
                AppState.cghVideo.index = 0;
            } else {
                stopCGHVideo();
                return;
            }
        }
        let guard = 0;
        while (guard < frames.length && !frames[AppState.cghVideo.index].phase) {
            AppState.cghVideo.index = (AppState.cghVideo.index + 1) % frames.length;
            guard++;
        }
        if (guard >= frames.length) {
            stopCGHVideo();
            return;
        }
        const displayedFrame = frames[AppState.cghVideo.index];
        showCGHVideoFrame(AppState.cghVideo.index);
        AppState.cghVideo.index++;
        const duration = Number(displayedFrame.duration_ms);
        const delay = Number.isFinite(duration) && duration > 0
            ? Math.max(20, Math.min(60000, duration))
            : interval;
        AppState.cghVideo.timer = setTimeout(advanceCGHVideo, delay);
    };

    advanceCGHVideo();

    document.getElementById('cgh_video_play_btn').disabled = true;
    document.getElementById('cgh_video_pause_btn').disabled = false;
    showNotification('CGH 视频播放已开始', 'info');
}

function pauseCGHVideo() {
    if (AppState.cghVideo.timer) {
        clearTimeout(AppState.cghVideo.timer);
        AppState.cghVideo.timer = null;
        AppState.cghVideo.playing = false;

        document.getElementById('cgh_video_play_btn').disabled = false;
        document.getElementById('cgh_video_pause_btn').disabled = true;

        showNotification('CGH 视频播放已暂停', 'info');
    }
}

function stopCGHVideo() {
    if (AppState.cghVideo.timer) {
        clearTimeout(AppState.cghVideo.timer);
        AppState.cghVideo.timer = null;
    }
    const wasPlaying = AppState.cghVideo.playing;
    AppState.cghVideo.playing = false;
    AppState.cghVideo.index = 0;
    const playBtn = document.getElementById('cgh_video_play_btn');
    const pauseBtn = document.getElementById('cgh_video_pause_btn');
    if (playBtn) playBtn.disabled = false;
    if (pauseBtn) pauseBtn.disabled = true;
    if (wasPlaying) showNotification('CGH 视频播放已停止', 'info');
    updateCGHVideoControls();
}

async function calculateCGHVideoSequence() {
    const frames = AppState.cghVideo.frames;
    if (!frames.length) {
        showNotification('视频序列为空，请先添加帧', 'warning');
        return;
    }
    if (AppState.cghVideo.calculating) return;

    const pendingCount = frames.filter(frame => !frame.phase).length;
    if (pendingCount === 0) {
        showNotification('所有帧均已计算完成', 'info');
        return;
    }
    if (!window.confirm(`将按当前 CGH 参数计算 ${pendingCount} 帧（迭代次数较多时耗时较长），是否继续？`)) {
        return;
    }

    AppState.cghVideo.calculating = true;
    stopCGHVideo();

    const statusEl = document.getElementById('cgh_video_status');
    const payloadParams = {
        algorithm: document.getElementById('cgh_algorithm').value,
        light_shape: document.getElementById('cgh_light_shape').value,
        light_size: parseFloat(document.getElementById('cgh_light_size').value),
        iterations: parseInt(document.getElementById('cgh_repetition').value),
        width: parseInt(document.getElementById('cgh_width').value),
        height: parseInt(document.getElementById('cgh_height').value),
        gaussian_spots: parseInt(document.getElementById('cgh_gaussian_spots').value) === 1,
        spot_radius: parseFloat(document.getElementById('cgh_spot_radius').value)
    };

    let successCount = 0;
    let failureCount = 0;
    try {
        for (const [index, frame] of frames.entries()) {
            if (frame.phase) continue;
            if (statusEl) {
                statusEl.textContent = `批量计算中：第 ${index + 1}/${frames.length} 帧...`;
            }
            if (!frame.target) {
                failureCount++;
                continue;
            }
            try {
                const response = await fetch('/api/cgh/calculate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        target_image: frame.target,
                        ...payloadParams
                    })
                });
                const data = await response.json();
                if (!response.ok || !data.success) {
                    throw new Error(data.error || `HTTP ${response.status}`);
                }
                frame.phase = data.cgh_image;
                frame.regenerated = data.regenerated_image;
                frame.filename = data.filename;
                successCount++;
            } catch (error) {
                failureCount++;
                console.error(`第 ${index + 1} 帧CGH计算失败:`, error);
                if (statusEl) statusEl.textContent = `第 ${index + 1} 帧计算失败: ${error.message}`;
            }
            renderCGHVideoFrames();
        }
    } finally {
        AppState.cghVideo.calculating = false;
        renderCGHVideoFrames();
        if (statusEl) {
            statusEl.textContent = failureCount
                ? `批量计算完成：成功 ${successCount} 帧，失败 ${failureCount} 帧`
                : `批量计算完成：共 ${successCount} 帧相位图，可点击播放`;
        }
        showNotification(
            failureCount ? `批量计算完成，${failureCount} 帧失败` : `批量计算完成（${successCount} 帧）`,
            failureCount ? 'warning' : 'success'
        );
        if (successCount > 0) showCGHVideoFrame(AppState.cghVideo.index);
    }
}

async function exportCGHVideoZip() {
    const frames = AppState.cghVideo.frames.filter(frame => frame.phase);
    if (!frames.length) {
        showNotification('暂无已计算的相位图可导出', 'warning');
        return;
    }
    try {
        const response = await fetch('/api/cgh/sequence/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                frames: frames.map(frame => frame.phase),
                prefix: 'cgh'
            })
        });
        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                message = (await response.json()).error || message;
            } catch (_) { /* 保留 HTTP 状态信息 */ }
            throw new Error(message);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `cgh_video_sequence_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showNotification(`已导出 ${frames.length} 帧 8-bit BMP 序列 ZIP`, 'success');
    } catch (error) {
        showNotification('导出失败: ' + error.message, 'error');
    }
}

// ==================== BMP 转换器 ====================
let converterUploadedImage = null;
let converterOutputData = null;

function initializeConverterUpload() {
    const dropZone = document.getElementById('converter_drop_zone');
    const fileInput = document.getElementById('converter_input_image');

    if (!dropZone || !fileInput) return;

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--primary-color)';
        dropZone.style.background = '#f0f8ff';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '';
        dropZone.style.background = '';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '';
        dropZone.style.background = '';

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleConverterImageUpload(files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleConverterImageUpload(e.target.files[0]);
        }
    });
}

function handleConverterImageUpload(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        converterUploadedImage = e.target.result;

        const preview = document.getElementById('converter_image_preview');
        const previewImg = document.getElementById('converter_preview_img');
        const dropZone = document.getElementById('converter_drop_zone');
        const info = document.getElementById('converter_input_info');

        if (preview && previewImg && dropZone) {
            previewImg.src = e.target.result;
            preview.style.display = 'block';
            dropZone.style.display = 'none';
        }

        if (info) {
            info.textContent = `文件名: ${file.name}, 大小: ${(file.size / 1024).toFixed(1)} KB`;
        }

        // 如果勾选了保持原始尺寸，获取图片实际尺寸
        const keepSize = document.getElementById('converter_keep_size');
        if (keepSize && keepSize.checked) {
            const img = new Image();
            img.onload = function() {
                document.getElementById('converter_width').value = img.width;
                document.getElementById('converter_height').value = img.height;
            };
            img.src = e.target.result;
        }
    };
    reader.readAsDataURL(file);
}

function removeConverterImage() {
    converterUploadedImage = null;
    converterOutputData = null;

    const preview = document.getElementById('converter_image_preview');
    const dropZone = document.getElementById('converter_drop_zone');
    const previewImg = document.getElementById('converter_preview_img');
    const outputImg = document.getElementById('converter_output_img');
    const outputPlaceholder = document.getElementById('converter_output_placeholder');
    const info = document.getElementById('converter_input_info');
    const outputInfo = document.getElementById('converter_output_info');

    if (preview && dropZone) {
        preview.style.display = 'none';
        dropZone.style.display = 'block';
    }

    if (previewImg) previewImg.src = '';
    if (outputImg) {
        outputImg.src = '';
        outputImg.style.display = 'none';
    }
    if (outputPlaceholder) outputPlaceholder.style.display = 'block';
    if (info) info.textContent = '尚未选择图像';
    if (outputInfo) outputInfo.textContent = '等待转换...';

    const downloadBtn = document.getElementById('converter_download_btn');
    if (downloadBtn) downloadBtn.disabled = true;

    const fileInput = document.getElementById('converter_input_image');
    if (fileInput) fileInput.value = '';
}

function toggleConverterSizeInputs() {
    const keepSize = document.getElementById('converter_keep_size').checked;
    document.getElementById('converter_width').disabled = keepSize;
    document.getElementById('converter_height').disabled = keepSize;

    if (keepSize && converterUploadedImage) {
        const img = new Image();
        img.onload = function() {
            document.getElementById('converter_width').value = img.width;
            document.getElementById('converter_height').value = img.height;
        };
        img.src = converterUploadedImage;
    }
}

async function convertToBmp() {
    if (!converterUploadedImage) {
        showNotification('请先上传图像', 'warning');
        return;
    }

    showLoading(true);

    const keepSize = document.getElementById('converter_keep_size').checked;
    const params = {
        image: converterUploadedImage,
        grayscale: parseInt(document.getElementById('converter_grayscale').value) === 1
    };

    if (!keepSize) {
        params.width = parseInt(document.getElementById('converter_width').value);
        params.height = parseInt(document.getElementById('converter_height').value);
    }

    try {
        const response = await fetch('/api/convert-to-bmp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const data = await response.json();

        if (data.success) {
            converterOutputData = data;

            const outputImg = document.getElementById('converter_output_img');
            const outputPlaceholder = document.getElementById('converter_output_placeholder');
            const outputInfo = document.getElementById('converter_output_info');

            if (outputImg && outputPlaceholder) {
                outputImg.src = data.image;
                outputImg.style.display = 'block';
                outputPlaceholder.style.display = 'none';
            }

            if (outputInfo) {
                const info = data.info;
                outputInfo.innerHTML = `
                    原始格式: ${info.original_format || '未知'}<br>
                    原始尺寸: ${info.original_size[0]}×${info.original_size[1]}<br>
                    输出尺寸: ${info.output_size[0]}×${info.output_size[1]}<br>
                    输出位深: ${info.output_bit_depth}-bit
                `;
            }

            document.getElementById('converter_download_btn').disabled = false;
            showNotification('图像已成功转换为 8-bit BMP', 'success');
        } else {
            throw new Error(data.error || '转换失败');
        }
    } catch (error) {
        console.error('转换错误:', error);
        showNotification('转换失败: ' + error.message, 'error');
    } finally {
        showLoading(false);
    }
}

function downloadConvertedBmp() {
    if (converterOutputData && converterOutputData.filename) {
        const link = document.createElement('a');
        link.href = `/api/download/${converterOutputData.filename}`;
        link.download = converterOutputData.filename;
        link.click();
        showNotification('8-bit BMP 下载已开始', 'success');
    } else {
        showNotification('请先生成 BMP 图像', 'warning');
    }
}

function resetConverter() {
    removeConverterImage();
    document.getElementById('converter_width').value = 1272;
    document.getElementById('converter_height').value = 1024;
    document.getElementById('converter_keep_size').checked = false;
    document.getElementById('converter_grayscale').value = '1';
    toggleConverterSizeInputs();
    showNotification('转换器已重置', 'info');
}

function saveModuleAsPreset(moduleId) {
    if (moduleId !== 'fresnel') {
        showNotification('目前仅支持保存菲涅尔透镜参数', 'warning');
        return;
    }

    const preset = {
        focus_mm: Number(document.getElementById('focus_mm').value),
        wavelength_nm: Number(document.getElementById('wavelength_nm').value),
        x_pixels: Number(document.getElementById('x_pixels').value),
        y_pixels: Number(document.getElementById('y_pixels').value),
        pitch_mode: Number(document.getElementById('pitch_mode').value),
        rotation_degree: Number(document.getElementById('rotation_degree').value),
        offset_x: Number(document.getElementById('offset_x').value),
        offset_y: Number(document.getElementById('offset_y').value),
        scale_factor: Number(document.getElementById('scale_factor').value)
    };
    if (Object.values(preset).some(value => !Number.isFinite(value))) {
        showNotification('请检查菲涅尔参数后再保存', 'warning');
        return;
    }

    const defaultName = `菲涅尔 f=${preset.focus_mm}mm λ=${preset.wavelength_nm}nm`;
    const name = window.prompt('预设名称', defaultName)?.trim();
    if (!name) return;
    if (name.length > 100) {
        showNotification('预设名称不能超过 100 个字符', 'warning');
        return;
    }

    fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...preset,
            name,
            description: '菲涅尔透镜参数'
        })
    })
        .then(async response => {
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || '保存失败');
            showNotification('参数预设已保存', 'success');
            loadPresets();
        })
        .catch(error => showNotification(`预设保存失败: ${error.message}`, 'error'));
}

async function loadPresets() {
    const list = document.getElementById('preset_list');
    if (!list) return;
    try {
        const response = await fetch('/api/presets');
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || '加载失败');
        renderPresetList(data.presets);
    } catch (error) {
        list.replaceChildren();
        const empty = document.createElement('li');
        empty.className = 'preset-empty';
        empty.textContent = '预设加载失败';
        list.append(empty);
        console.error('加载预设失败:', error);
    }
}

function renderPresetList(presets) {
    const list = document.getElementById('preset_list');
    list.replaceChildren();
    if (!presets.length) {
        const empty = document.createElement('li');
        empty.className = 'preset-empty';
        empty.textContent = '暂无预设';
        list.append(empty);
        return;
    }

    presets.forEach(preset => {
        const item = document.createElement('li');
        item.className = 'preset-entry';

        const applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'preset-apply';
        applyButton.addEventListener('click', () => applyPreset(preset));
        const name = document.createElement('span');
        name.className = 'pattern-name';
        name.textContent = preset.name;
        const details = document.createElement('span');
        details.className = 'preset-meta';
        details.textContent = `f=${preset.focus_mm} mm · λ=${preset.wavelength_nm} nm`;
        applyButton.append(name, details);

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'preset-delete';
        deleteButton.textContent = '×';
        deleteButton.title = `删除预设 ${preset.name}`;
        deleteButton.setAttribute('aria-label', deleteButton.title);
        deleteButton.addEventListener('click', () => deletePreset(preset));
        item.append(applyButton, deleteButton);
        list.append(item);
    });
}

function applyPreset(preset) {
    const values = {
        focus_mm: preset.focus_mm,
        wavelength_nm: preset.wavelength_nm,
        x_pixels: preset.x_pixels,
        y_pixels: preset.y_pixels,
        pitch_mode: preset.pitch_mode,
        rotation_degree: preset.rotation_degree,
        offset_x: preset.offset_x,
        offset_y: preset.offset_y,
        scale_factor: preset.scale_factor
    };
    Object.entries(values).forEach(([id, value]) => {
        const input = document.getElementById(id);
        if (input && value !== null && value !== undefined) input.value = value;
    });
    document.getElementById('focus_slider').value = preset.focus_mm;
    document.getElementById('rotation_slider').value = preset.rotation_degree;
    setWavelength(preset.wavelength_nm);
    showModule('fresnel');
    showNotification(`已加载预设「${preset.name}」，可继续生成相位图`, 'success');
}

async function deletePreset(preset) {
    if (!window.confirm(`删除预设「${preset.name}」？`)) return;
    try {
        const response = await fetch(`/api/presets/${Number(preset.id)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || '删除失败');
        showNotification('参数预设已删除', 'success');
        await loadPresets();
    } catch (error) {
        showNotification(`预设删除失败: ${error.message}`, 'error');
    }
}

function zoomIn() {
    AppState.zoomLevel = Math.min(AppState.zoomLevel * 1.2, 3);
    applyZoom();
}

function zoomOut() {
    AppState.zoomLevel = Math.max(AppState.zoomLevel / 1.2, 0.5);
    applyZoom();
}

function resetZoom() {
    AppState.zoomLevel = 1;
    applyZoom();
}

function applyZoom() {
    const img = document.getElementById('phase_image');
    if (img) {
        img.style.transform = `scale(${AppState.zoomLevel})`;
    }
}

function switchTab(event) {
    const link = event?.currentTarget;
    if (!link) return false;

    if (link.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        showNotification(
            link.getAttribute('data-unavailable-message') || '该视图尚未实现',
            'info'
        );
        return false;
    }

    const href = link.getAttribute('href') || '';
    const sectionId = href.startsWith('#') ? href.slice(1) : '';
    const section = sectionId ? document.getElementById(sectionId) : null;
    if (!section) {
        event.preventDefault();
        showNotification('菜单目标不可用', 'warning');
        return false;
    }

    event.preventDefault();
    document.querySelectorAll('.menu-item').forEach(item => {
        item.classList.remove('active');
    });
    link.classList.add('active');
    showModule(sectionId);
    return true;
}

function showModule(moduleId) {
    const target = document.getElementById(moduleId);
    if (!target || !target.classList.contains('module-card')) return;

    // 单窗口模式：仅显示目标模块，其余模块隐藏
    document.querySelectorAll('.workspace > .module-card').forEach(section => {
        section.classList.toggle('module-active', section.id === moduleId);
    });

    // 更新左侧导航激活状态
    document.querySelectorAll('.nav-list li').forEach(li => {
        li.classList.remove('active');
    });

    const activeNav = document.querySelector(`.nav-list li[onclick="showModule('${moduleId}')"]`);
    if (activeNav) {
        activeNav.classList.add('active');
    }

    // 切换后从模块标题开始显示
    const workspace = document.querySelector('.workspace');
    if (workspace) workspace.scrollTop = 0;
}

function startWorkflow(action) {
    if (action === 'new') {
        if (window.confirm('新建项目会清空当前页面设置和播放序列。尚未保存的内容将丢失。')) {
            window.location.reload();
        }
        return;
    }
    if (action === 'save') {
        saveWorkflowProject();
        return;
    }
    if (action === 'open') {
        openWorkflowProject();
        return;
    }
    showNotification('未知的项目操作', 'warning');
}

function captureProjectControls() {
    const controls = {};
    document.querySelectorAll('.workspace input[id], .workspace select[id], .workspace textarea[id]')
        .forEach(control => {
            if (['button', 'submit', 'reset', 'file', 'hidden'].includes(control.type)) return;
            controls[control.id] = control.type === 'checkbox' ? control.checked : control.value;
        });
    return controls;
}

function serializeProjectImage(source, budget, label) {
    const data = validateProjectImage(source);
    if (!data) return null;
    const dimensions = readProjectImageDimensions(data);
    const pixels = dimensions.width * dimensions.height;
    if (!Number.isSafeInteger(pixels) ||
        dimensions.width > MAX_PROJECT_IMAGE_DIMENSION ||
        dimensions.height > MAX_PROJECT_IMAGE_DIMENSION || pixels > MAX_PROJECT_IMAGE_PIXELS) {
        throw new Error(`${label}尺寸超过项目导入限制`);
    }
    budget.pixels += pixels;
    if (budget.pixels > MAX_PROJECT_TOTAL_IMAGE_PIXELS) {
        throw new Error('项目图像总像素超过导入限制');
    }
    return data;
}

function serializeProjectSequenceItem(item, imageBudget) {
    const saved = {
        id: item.id,
        image: serializeProjectImage(item.image, imageBudget, '序列相位图'),
        patternType: item.patternType || 'pattern',
        filename: item.filename || '',
        params: item.params || ''
    };
    if (item.paintAnimation) {
        saved.paintAnimation = {
            source: serializeProjectImage(
                item.paintAnimation.source.toDataURL('image/png'), imageBudget, '动画源图'
            ),
            phaseImage: serializeProjectImage(
                item.paintAnimation.phaseImage.src, imageBudget, '动画相位图'
            ),
            clips: item.paintAnimation.clips,
            fps: item.paintAnimation.fps
        };
    }
    return saved;
}

function serializeProjectCGHVideo(imageBudget) {
    return {
        frames: (AppState.cghVideo?.frames || []).filter(frame => frame.source !== 'motion').map((frame, index) => ({
            id: frame.id,
            label: typeof frame.label === 'string' ? frame.label.slice(0, 200) : '',
            target: serializeProjectImage(
                frame.target, imageBudget, `第 ${index + 1} 个视频帧目标图`
            ),
            phase: serializeProjectImage(
                frame.phase, imageBudget, `第 ${index + 1} 个视频帧相位图`
            ),
            regenerated: serializeProjectImage(
                frame.regenerated, imageBudget, `第 ${index + 1} 个视频帧再建图`
            )
        }))
    };
}

function saveWorkflowProject() {
    try {
        const imageBudget = { pixels: 0 };
        const spotArray = typeof getSpotArrayProjectState === 'function'
            ? getSpotArrayProjectState()
            : null;
        const currentPatternType = AppState.currentPatternType || 'pattern';
        const currentOutput = AppState.currentImageData?.image
            ? {
                image: serializeProjectImage(
                    AppState.currentImageData.image, imageBudget, '主预览图'
                ),
                patternType: currentPatternType,
                filename: AppState.currentImageData.filename || '',
                params: AppState.currentImageData.paramsDescription || '',
                infoFocus: currentPatternType === 'cgh'
                    ? 'CGH'
                    : document.getElementById('info_focus')?.textContent || '',
                infoWavelength: currentPatternType === 'cgh'
                    ? 'N/A'
                    : document.getElementById('info_wavelength')?.textContent || ''
            }
            : null;
        const cghData = AppState.cghData || {};
        const cghTargetLabel = document.getElementById('cgh_target_path')?.value || '';
        const cghPhaseReusesCurrentOutput = Boolean(
            currentOutput && cghData.cghImage && cghData.cghImage === AppState.currentImageData.image
        );
        const cgh = {
            target_image: serializeProjectImage(cghData.targetImage, imageBudget, 'CGH 目标图'),
            phase_image: cghPhaseReusesCurrentOutput
                ? null
                : serializeProjectImage(cghData.cghImage, imageBudget, 'CGH 相位图'),
            phase_image_ref: cghPhaseReusesCurrentOutput ? 'current_output' : null,
            regenerated_image: serializeProjectImage(
                cghData.regeneratedImage, imageBudget, 'CGH 重建图'
            ),
            light_shape_image: serializeProjectImage(
                cghData.lightShapeImage, imageBudget, 'CGH 光斑图'
            ),
            filename: typeof cghData.filename === 'string' ? cghData.filename : '',
            target_label: cghTargetLabel.slice(0, 200)
        };
        const project = {
            format: 'slmjomo-project',
            version: 2,
            saved_at: new Date().toISOString(),
            controls: captureProjectControls(),
            uploaded_image: serializeProjectImage(
                AppState.uploadedImage, imageBudget, '上传图像'
            ),
            spot_array: spotArray,
            sequence: AppState.sequenceList.map(item =>
                serializeProjectSequenceItem(item, imageBudget)
            ),
            cgh_video: serializeProjectCGHVideo(imageBudget),
            spot_motion: typeof window !== 'undefined' &&
                typeof window.SpotMotion?.getProjectState === 'function'
                ? (() => {
                    const motion = window.SpotMotion.getProjectState();
                    return {
                        ...motion,
                        image_data_url: serializeProjectImage(
                            motion.image_data_url, imageBudget, '显微镜图像'
                        )
                    };
                })()
                : null,
            current_output: currentOutput,
            cgh
        };
        const contents = JSON.stringify(project, null, 2);
        if (contents.length > 32 * 1024 * 1024) {
            throw new Error('项目文件超过 32 MB，请减少序列帧或单独保存绘图任务');
        }
        const blob = new Blob([contents], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `slmjomo_project_${new Date().toISOString().replace(/[:.]/g, '-')}.slmproject.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showNotification('项目文件已保存', 'success');
    } catch (error) {
        showNotification(`项目保存失败: ${error.message}`, 'error');
    }
}

function openWorkflowProject() {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.json,.slmproject.json,application/json';
    picker.hidden = true;
    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        picker.remove();
        if (!file) return;
        try {
            if (file.size > 32 * 1024 * 1024) throw new Error('项目文件不能超过 32 MB');
            const project = JSON.parse(await file.text());
            await restoreWorkflowProject(project);
            showNotification('项目已打开', 'success');
        } catch (error) {
            showNotification(`项目打开失败: ${error.message}`, 'error');
        }
    }, { once: true });
    picker.addEventListener('cancel', () => picker.remove(), { once: true });
    document.body.append(picker);
    picker.click();
}

const MAX_PROJECT_IMAGE_DIMENSION = 8192;
const MAX_PROJECT_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_PROJECT_TOTAL_IMAGE_PIXELS = 64 * 1024 * 1024;

function validateProjectImage(image) {
    if (image === null || image === undefined || image === '') return null;
    if (typeof image !== 'string' || image.length > 24 * 1024 * 1024 ||
        !/^data:image\/(png|jpeg|jpg|bmp|webp|gif|tiff);base64,[A-Za-z0-9+/=\r\n]+$/i.test(image)) {
        throw new Error('项目中包含无效或过大的图像');
    }
    return image;
}

async function loadValidatedProjectImage(source, budget, label) {
    const data = validateProjectImage(source);
    if (!data) return null;
    const dimensions = readProjectImageDimensions(data);
    const pixels = dimensions.width * dimensions.height;
    if (!Number.isSafeInteger(pixels) ||
        dimensions.width > MAX_PROJECT_IMAGE_DIMENSION ||
        dimensions.height > MAX_PROJECT_IMAGE_DIMENSION || pixels > MAX_PROJECT_IMAGE_PIXELS) {
        throw new Error(`${label}尺寸超过项目导入限制`);
    }
    const totalPixels = budget.pixels + pixels;
    if (totalPixels > MAX_PROJECT_TOTAL_IMAGE_PIXELS) {
        throw new Error('项目图像总像素超过导入限制');
    }
    const image = await loadPaintImage(data);
    if (!projectImageDimensionsMatch(data, dimensions, {
        width: image.naturalWidth,
        height: image.naturalHeight
    })) {
        throw new Error(`${label}图像头部尺寸与实际图像不一致`);
    }
    budget.pixels = totalPixels;
    return { data, image };
}

function validateProjectControls(controls) {
    if (!controls || typeof controls !== 'object' || Array.isArray(controls) ||
        Object.keys(controls).length > 500) {
        throw new Error('项目参数格式无效');
    }
    const accepted = [];
    Object.entries(controls).forEach(([id, value]) => {
        const control = document.getElementById(id);
        if (!control || !control.closest('.workspace') ||
            ['button', 'submit', 'reset', 'file', 'hidden'].includes(control.type)) return;
        // 跳过暂态空 select（如傅里叶序列帧浏览器），其选项仅在会话内动态生成
        if (control.tagName === 'SELECT' && control.options.length === 0) return;
        if (control.type === 'checkbox') {
            if (typeof value !== 'boolean') throw new Error(`参数 ${id} 格式无效`);
        } else if (control.tagName === 'SELECT') {
            if (typeof value !== 'string' || !Array.from(control.options).some(option => option.value === value)) {
                throw new Error(`参数 ${id} 不受支持`);
            }
        } else if (control.type === 'number' || control.type === 'range') {
            if (value === '' && control.type === 'number') return accepted.push([control, '']);
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue) ||
                (control.min !== '' && numericValue < Number(control.min)) ||
                (control.max !== '' && numericValue > Number(control.max))) {
                throw new Error(`参数 ${id} 超出允许范围`);
            }
            value = String(numericValue);
        } else if (typeof value !== 'string' || value.length > 4096) {
            throw new Error(`参数 ${id} 格式无效`);
        }
        accepted.push([control, value]);
    });
    return accepted;
}

async function restoreProjectSequence(sequence, imageBudget) {
    if (!Array.isArray(sequence) || sequence.length > 100) {
        throw new Error('项目序列格式无效或项目包含过多序列项');
    }
    const restored = [];
    for (const [index, item] of sequence.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 个序列项格式无效`);
        }
        const phase = await loadValidatedProjectImage(
            item.image, imageBudget, `第 ${index + 1} 个序列项相位图`
        );
        if (!phase) throw new Error(`第 ${index + 1} 个序列项缺少相位图`);
        const patternType = typeof item.patternType === 'string' && item.patternType.length <= 80
            ? item.patternType
            : 'pattern';
        const filename = typeof item.filename === 'string' && item.filename.length <= 200
            ? item.filename
            : '';
        const params = typeof item.params === 'string' && item.params.length <= 500
            ? item.params
            : '';
        const saved = {
            id: Number.isSafeInteger(item.id) && item.id > 0 ? item.id : Date.now() + index,
            image: phase.data,
            patternType,
            filename,
            params
        };
        if (item.paintAnimation !== undefined) {
            const animation = item.paintAnimation;
            const source = await loadValidatedProjectImage(
                animation?.source, imageBudget, `第 ${index + 1} 个动画源图`
            );
            const animationPhase = await loadValidatedProjectImage(
                animation?.phaseImage, imageBudget, `第 ${index + 1} 个动画相位图`
            );
            if (!source || !animationPhase || !Array.isArray(animation.clips)) {
                throw new Error(`第 ${index + 1} 个绘图动画格式无效`);
            }
            const clips = sanitizePaintClips(animation.clips);
            const durationMs = getPaintTotalDuration(clips);
            if (durationMs > 60000) throw new Error('项目中的绘图动画时长不能超过 60 秒');
            const fps = Math.max(1, Math.min(30, Number(animation.fps) || 10));
            const sourceCanvas = document.createElement('canvas');
            sourceCanvas.width = source.image.naturalWidth;
            sourceCanvas.height = source.image.naturalHeight;
            sourceCanvas.getContext('2d').drawImage(source.image, 0, 0);
            saved.paintAnimation = {
                source: sourceCanvas,
                phaseImage: animationPhase.image,
                clips,
                fps,
                durationMs,
                frameCount: getPaintFrameCount(clips, fps)
            };
        }
        restored.push(saved);
    }
    return restored;
}

async function restoreProjectCurrentOutput(source, imageBudget) {
    if (source === null || source === undefined) return null;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('项目主预览状态无效');
    }
    const phase = await loadValidatedProjectImage(source.image, imageBudget, '主预览图');
    if (!phase) throw new Error('项目主预览图缺少图像');
    return {
        image: phase.data,
        patternType: typeof source.patternType === 'string' && source.patternType.length <= 80
            ? source.patternType
            : 'pattern',
        filename: typeof source.filename === 'string' && source.filename.length <= 200
            ? source.filename
            : '',
        paramsDescription: typeof source.params === 'string' && source.params.length <= 500
            ? source.params
            : '',
        infoFocus: typeof source.infoFocus === 'string' && source.infoFocus.length <= 100
            ? source.infoFocus
            : '',
        infoWavelength: typeof source.infoWavelength === 'string' && source.infoWavelength.length <= 100
            ? source.infoWavelength
            : '',
        decodedImage: phase.image
    };
}

async function restoreProjectCGH(source, imageBudget, currentOutput = null) {
    const empty = {
        data: {
            targetImage: null,
            cghImage: null,
            regeneratedImage: null,
            lightShapeImage: null,
            filename: null
        },
        targetLabel: '',
        target: null,
        phase: null,
        regenerated: null,
        lightShape: null
    };
    if (source === null || source === undefined) return empty;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('项目 CGH 状态无效');
    }
    const target = await loadValidatedProjectImage(
        source.target_image, imageBudget, 'CGH 目标图'
    );
    let phase;
    if (source.phase_image_ref === 'current_output') {
        if (!currentOutput) throw new Error('项目 CGH 相位图引用无效');
        phase = { data: currentOutput.image, image: currentOutput.decodedImage };
    } else {
        if (source.phase_image_ref !== null && source.phase_image_ref !== undefined) {
            throw new Error('项目 CGH 相位图引用无效');
        }
        phase = await loadValidatedProjectImage(
            source.phase_image, imageBudget, 'CGH 相位图'
        );
    }
    const regenerated = await loadValidatedProjectImage(
        source.regenerated_image, imageBudget, 'CGH 重建图'
    );
    const lightShape = await loadValidatedProjectImage(
        source.light_shape_image, imageBudget, 'CGH 光斑图'
    );
    return {
        data: {
            targetImage: target?.data || null,
            cghImage: phase?.data || null,
            regeneratedImage: regenerated?.data || null,
            lightShapeImage: lightShape?.data || null,
            filename: typeof source.filename === 'string' && source.filename.length <= 200
                ? source.filename
                : null
        },
        targetLabel: typeof source.target_label === 'string'
            ? source.target_label.slice(0, 200)
            : '',
        target,
        phase,
        regenerated,
        lightShape
    };
}

async function restoreProjectCGHVideo(source, imageBudget) {
    const frames = [];
    if (source === null || source === undefined) return frames;
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        !Array.isArray(source.frames)) {
        throw new Error('项目 CGH 视频序列格式无效');
    }
    // 上限与 CGH_VIDEO_MAX_FRAMES 保持一致；此处使用字面量，
    // 因为项目序列化区可能被独立提取运行（见 test_project_roundtrip.cjs）
    if (source.frames.length > 200) {
        throw new Error('项目 CGH 视频序列帧数过多');
    }
    for (const [index, item] of source.frames.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 个视频帧格式无效`);
        }
        const target = await loadValidatedProjectImage(
            item.target, imageBudget, `第 ${index + 1} 个视频帧目标图`
        );
        const phase = await loadValidatedProjectImage(
            item.phase, imageBudget, `第 ${index + 1} 个视频帧相位图`
        );
        const regenerated = await loadValidatedProjectImage(
            item.regenerated, imageBudget, `第 ${index + 1} 个视频帧再建图`
        );
        if (!phase && !target) {
            throw new Error(`第 ${index + 1} 个视频帧缺少图像`);
        }
        frames.push({
            id: Number.isSafeInteger(item.id) && item.id > 0 ? item.id : Date.now() + index,
            label: typeof item.label === 'string' ? item.label.slice(0, 200) : '',
            target: target?.data || null,
            phase: phase?.data || null,
            regenerated: regenerated?.data || null,
            filename: ''
        });
    }
    return frames;
}

function drawProjectPreview(canvasId, placeholderId, image) {
    const canvas = document.getElementById(canvasId);
    const placeholder = document.getElementById(placeholderId);
    if (!canvas || !placeholder) return;
    if (!image) {
        canvas.style.display = 'none';
        placeholder.style.display = 'block';
        return;
    }
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    canvas.style.display = 'block';
    placeholder.style.display = 'none';
}

function restoreProjectCGHView(restored) {
    const cghTargetPath = document.getElementById('cgh_target_path');
    cghTargetPath.value = restored.targetLabel;
    const targetImage = document.getElementById('cgh_target_image');
    const targetPlaceholder = document.getElementById('cgh_target_placeholder');
    if (restored.target) {
        targetImage.src = restored.target.data;
        targetImage.style.display = 'block';
        targetPlaceholder.style.display = 'none';
    } else {
        targetImage.removeAttribute('src');
        targetImage.style.display = 'none';
        targetPlaceholder.style.display = 'block';
    }
    drawProjectPreview('cgh_light_canvas', 'cgh_light_placeholder', restored.lightShape?.image);
    drawProjectPreview('cgh_regenerate_canvas', 'cgh_regenerate_placeholder', restored.regenerated?.image);
    document.getElementById('cgh_download_btn').disabled = !restored.data.filename;
    document.getElementById('cgh_send_btn').disabled = !restored.data.cghImage;
    document.getElementById('cgh_image_info').textContent = restored.data.cghImage
        ? '已恢复项目中的 CGH 相位图'
        : '等待生成...';
}

async function restoreWorkflowProject(project) {
    if (!project || project.format !== 'slmjomo-project' || ![1, 2].includes(project.version)) {
        throw new Error('项目文件格式或版本不受支持');
    }
    const controls = validateProjectControls(project.controls);
    const imageBudget = { pixels: 0 };
    const uploadedProjectImage = await loadValidatedProjectImage(
        project.uploaded_image, imageBudget, '上传图像'
    );
    const sequence = await restoreProjectSequence(project.sequence, imageBudget);
    const uploadedImage = uploadedProjectImage?.data || null;
    const currentOutput = project.version >= 2
        ? await restoreProjectCurrentOutput(project.current_output, imageBudget)
        : null;
    const cgh = project.version >= 2
        ? await restoreProjectCGH(project.cgh, imageBudget, currentOutput)
        : await restoreProjectCGH(null, imageBudget);
    // 兼容旧项目文件：slam_ 命名迁移到 spot_motion
    if (project.version >= 2 && project.cgh_video?.frames?.length) {
        project.cgh_video.frames.forEach(frame => {
            if (frame.source === 'slam') frame.source = 'motion';
        });
    }
    if (project.version >= 2 && project.slam_motion && !project.spot_motion) {
        project.spot_motion = project.slam_motion;
        delete project.slam_motion;
    }
    const cghVideoFrames = project.version >= 2
        ? await restoreProjectCGHVideo(project.cgh_video, imageBudget)
        : [];
    let spotMotion = project.version >= 2 && project.spot_motion
        ? project.spot_motion
        : null;
    if (spotMotion) {
        const microscope = await loadValidatedProjectImage(
            spotMotion.image_data_url, imageBudget, '显微镜图像'
        );
        spotMotion = { ...spotMotion, image_data_url: microscope?.data || null };
    }
    const spotArraySnapshot = Object.prototype.hasOwnProperty.call(project, 'spot_array')
        ? project.spot_array
        : null;
    const projectControlValues = Object.fromEntries(
        controls.map(([control, value]) => [control.id, value])
    );
    const validatedSpotArray = typeof validateSpotArrayProjectState === 'function'
        ? validateSpotArrayProjectState(spotArraySnapshot, projectControlValues)
        : null;

    if (typeof window !== 'undefined' &&
            typeof window.SpotMotion?.restoreProjectState === 'function') {
        await window.SpotMotion.restoreProjectState(spotMotion || {
            version: 1,
            image_data_url: null,
            markers: [],
            selected_marker_id: null,
            origin: null,
            assignments: [null, null, null],
            paths: [[], [], []],
            parameters: {}
        });
    }
    controls.forEach(([control, value]) => {
        if (control.type === 'checkbox') control.checked = value;
        else control.value = value;
    });
    document.getElementById('focus_slider').value = document.getElementById('focus_mm').value;
    document.getElementById('rotation_slider').value = document.getElementById('rotation_degree').value;
    setWavelength(document.getElementById('wavelength_nm').value);
    if (typeof restoreSpotArrayProjectState === 'function') {
        restoreSpotArrayProjectState(spotArraySnapshot, validatedSpotArray);
    }
    toggleThreeSpotOptimization();
    initializeThreeSpotDammannInfo();
    toggleThreeSpotOptimization('tsn');
    initializeThreeSpotDammannInfo('tsn');
    toggleConverterSizeInputs();
    toggleBeamRadiusInput();
    updateCylindricalDiag();
    updateDoubleRingRadiusLimits();
    renderDoubleRingTargetPreview();
    AppState.uploadedImage = uploadedImage;
    const preview = document.getElementById('image_preview');
    const previewImage = document.getElementById('preview_img');
    const dropZone = document.getElementById('drop_zone');
    if (uploadedImage) {
        previewImage.src = uploadedImage;
        preview.style.display = 'block';
        dropZone.style.display = 'none';
    } else {
        removeImage();
    }
    stopSequence();
    AppState.sequenceList = sequence;
    updateSequenceList();
    AppState.cghData = cgh.data;
    restoreProjectCGHView(cgh);
    stopCGHVideo();
    AppState.cghVideo.frames.filter(frame => frame.source === 'motion').forEach(frame => {
        [frame.phase, frame.regenerated].forEach(url => {
            if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
        });
    });
    AppState.cghVideo.frames = cghVideoFrames;
    AppState.cghVideo.index = 0;
    AppState.cghVideo.calculating = false;
    renderCGHVideoFrames();
    if (spotMotion && typeof window !== 'undefined' &&
            typeof window.SpotMotion?.restoreProjectState === 'function') {
        showNotification('标定与路径已恢复；需要重新生成相位帧后加入 CGH 序列', 'info');
    }
    const placeholder = document.querySelector('.preview-container .placeholder');
    if (currentOutput) {
        displayPhaseImage(currentOutput.image);
        AppState.currentImageData = {
            image: currentOutput.image,
            filename: currentOutput.filename,
            paramsDescription: currentOutput.paramsDescription
        };
        AppState.currentPatternType = currentOutput.patternType;
        document.getElementById('download_btn').disabled = !currentOutput.filename;
        document.getElementById('info_focus').textContent = currentOutput.infoFocus ||
            currentOutput.patternType.toUpperCase();
        document.getElementById('info_wavelength').textContent = currentOutput.infoWavelength || 'N/A';
        document.getElementById('info_resolution').textContent =
            currentOutput.decodedImage.naturalWidth + ' × ' + currentOutput.decodedImage.naturalHeight;
        document.getElementById('info_time').textContent = project.saved_at || '';
    } else {
        AppState.currentImageData = null;
        AppState.currentPatternType = null;
        const phaseImage = document.getElementById('phase_image');
        phaseImage.removeAttribute('src');
        phaseImage.style.display = 'none';
        if (placeholder) placeholder.style.display = 'block';
        document.getElementById('download_btn').disabled = true;
        document.getElementById('info_focus').textContent = 'N/A';
        document.getElementById('info_wavelength').textContent = 'N/A';
        document.getElementById('info_resolution').textContent = '-';
        document.getElementById('info_time').textContent = '';
    }
}

function loadRecentPattern(patternId) {
    const item = AppState.history.find(record => Number(record.id) === Number(patternId));
    if (!item) {
        showNotification('该历史记录已不可用', 'warning');
        return;
    }
    loadHistoryOutput(item);
}

// ==================== 傅里叶面强度模拟 ====================
let fourierPhaseImage = null;
let fourierResultData = null;

function toggleBeamRadiusInput() {
    const illuminationType = document.getElementById('fourier_illumination_type').value;
    const beamRadiusContainer = document.getElementById('fourier_beam_radius_container');
    beamRadiusContainer.style.display = illuminationType === 'gaussian' ? 'block' : 'none';
}

function useCurrentPhaseForFourier() {
    const phaseImg = document.getElementById('phase_image');
    if (!phaseImg || !phaseImg.src || phaseImg.style.display === 'none') {
        showNotification('请先生成或上传相位图', 'warning');
        return;
    }
    fourierPhaseImage = phaseImg.src;
    document.getElementById('fourier_input_status').textContent = '✅ 已使用当前生成的相位图';
    document.getElementById('fourier_input_status').style.color = '#28a745';
    showNotification('已加载当前相位图', 'success');
}

function handleFourierUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        fourierPhaseImage = e.target.result;
        document.getElementById('fourier_input_status').textContent = '✅ 已上传: ' + file.name;
        document.getElementById('fourier_input_status').style.color = '#28a745';
        showNotification('相位图上传成功', 'success');
    };
    reader.readAsDataURL(file);
}

async function runFourierSimulation() {
    if (!fourierPhaseImage) {
        showNotification('请先选择或上传相位图', 'warning');
        return;
    }

    showLoading(true);

    const params = {
        phase_image: fourierPhaseImage,
        illumination_type: document.getElementById('fourier_illumination_type').value,
        beam_radius: parseFloat(document.getElementById('fourier_beam_radius').value),
        width: parseInt(document.getElementById('fourier_width').value),
        height: parseInt(document.getElementById('fourier_height').value),
        colormap: document.getElementById('fourier_colormap').value
    };

    try {
        const response = await fetch('/api/simulate/fourier', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        const data = await response.json();

        if (data.success) {
            // 显示彩色强度图
            const colorImg = document.getElementById('fourier_color_img');
            const colorPlaceholder = document.getElementById('fourier_color_placeholder');
            colorImg.src = data.intensity_color_image;
            colorImg.style.display = 'block';
            colorPlaceholder.style.display = 'none';
            document.getElementById('fourier_colormap_label').textContent = 'Colormap: ' + data.colormap;

            // 显示对数强度图
            const logImg = document.getElementById('fourier_log_img');
            const logPlaceholder = document.getElementById('fourier_log_placeholder');
            logImg.src = data.intensity_log_image;
            logImg.style.display = 'block';
            logPlaceholder.style.display = 'none';

            // 显示原始强度图
            const rawImg = document.getElementById('fourier_raw_img');
            const rawPlaceholder = document.getElementById('fourier_raw_placeholder');
            rawImg.src = data.intensity_raw_image;
            rawImg.style.display = 'block';
            rawPlaceholder.style.display = 'none';

            // 显示照明光束预览
            const illumImg = document.getElementById('fourier_illumination_img');
            const illumPlaceholder = document.getElementById('fourier_illumination_placeholder');
            illumImg.src = data.illumination_preview;
            illumImg.style.display = 'block';
            illumPlaceholder.style.display = 'none';

            fourierResultData = data;
            document.getElementById('fourier_download_btn').disabled = false;
            hideFourierResultFrameBar();
            showNotification('傅里叶面强度模拟完成', 'success');
        } else {
            throw new Error(data.error || '模拟失败');
        }
    } catch (error) {
        console.error('模拟错误:', error);
        showNotification('模拟失败: ' + error.message, 'error');
    } finally {
        showLoading(false);
    }
}

function downloadFourierResult() {
    if (!fourierResultData || !fourierResultData.intensity_log_image) {
        showNotification('请先执行模拟', 'warning');
        return;
    }

    // 下载彩色强度图
    const link0 = document.createElement('a');
    link0.href = fourierResultData.intensity_color_image;
    link0.download = `fourier_color_${fourierResultData.colormap}_${Date.now()}.png`;
    link0.click();

    // 延迟下载对数强度图
    setTimeout(() => {
        const link = document.createElement('a');
        link.href = fourierResultData.intensity_log_image;
        link.download = `fourier_log_${Date.now()}.png`;
        link.click();
    }, 500);

    // 延迟下载原始强度图
    setTimeout(() => {
        const link2 = document.createElement('a');
        link2.href = fourierResultData.intensity_raw_image;
        link2.download = `fourier_raw_${Date.now()}.png`;
        link2.click();
    }, 1000);

    showNotification('傅里叶模拟结果下载已开始（共3张）', 'success');
}

// ==================== 傅里叶面序列（视频）播放 ====================
const FOURIER_SEQ_MAX_FRAMES = 60;
const FourierSeqState = {
    frames: [],        // { id, image, name }
    simFrames: [],     // 后端返回的强度帧 { intensityColor, intensityLog, meanIntensity, peakIntensity }
    simColormap: 'magma',
    simulated: false,
    playIndex: 0,
    playTimer: null,
    isPlaying: false
};

function setFourierSeqSimulated(simulated) {
    FourierSeqState.simulated = simulated;
    if (!simulated) {
        FourierSeqState.simFrames = [];
        hideFourierResultFrameBar();
    }
    document.getElementById('fourier_seq_gif_btn').disabled =
        FourierSeqState.frames.length === 0;
}

// ---- 序列模拟结果 → 三个强度分布面板 同步 ----
function setFourierResultPanelImage(imgId, placeholderId, src) {
    const img = document.getElementById(imgId);
    const placeholder = document.getElementById(placeholderId);
    img.src = src;
    img.style.display = 'block';
    placeholder.style.display = 'none';
}

function hideFourierResultFrameBar() {
    const bar = document.getElementById('fourier_result_frame_bar');
    if (!bar) return;
    bar.style.display = 'none';
    document.getElementById('fourier_result_frame_select').replaceChildren();
}

function fillFourierResultFrameSelect(selectedIndex) {
    const select = document.getElementById('fourier_result_frame_select');
    select.replaceChildren();
    FourierSeqState.simFrames.forEach((frame, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `帧 ${index + 1}/${FourierSeqState.simFrames.length}`;
        select.append(option);
    });
    select.value = String(selectedIndex);
}

function syncFourierResultFromSequence(frameIndex) {
    const frames = FourierSeqState.simFrames;
    if (!FourierSeqState.simulated || frames.length === 0) return;

    const safeIndex = Math.min(Math.max(0, frameIndex), frames.length - 1);
    const frame = frames[safeIndex];

    setFourierResultPanelImage('fourier_color_img', 'fourier_color_placeholder', frame.intensity_color);
    setFourierResultPanelImage('fourier_log_img', 'fourier_log_placeholder', frame.intensity_log);
    setFourierResultPanelImage('fourier_raw_img', 'fourier_raw_placeholder', frame.intensity_raw);
    document.getElementById('fourier_colormap_label').textContent =
        `Colormap: ${FourierSeqState.simColormap} · 序列帧 ${safeIndex + 1}/${frames.length}`;

    fillFourierResultFrameSelect(safeIndex);
    document.getElementById('fourier_result_frame_bar').style.display = 'block';
}

function onFourierResultFrameChange() {
    const select = document.getElementById('fourier_result_frame_select');
    syncFourierResultFromSequence(parseInt(select.value, 10) || 0);
}

function updateFourierSeqStatus() {
    const count = FourierSeqState.frames.length;
    document.getElementById('fourier_seq_status').textContent =
        `共 ${count} 帧（单次最多 ${FOURIER_SEQ_MAX_FRAMES} 帧）`;
}

function renderFourierSeqList() {
    const listEl = document.getElementById('fourier_seq_list');
    listEl.replaceChildren();

    FourierSeqState.frames.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'sequence-item';
        row.dataset.id = String(item.id);
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';

        const order = document.createElement('span');
        order.className = 'seq-index';
        order.textContent = `#${index + 1}`;

        const thumb = document.createElement('img');
        thumb.src = item.image;
        thumb.alt = `序列帧 ${index + 1}`;
        thumb.style.maxWidth = '48px';
        thumb.style.maxHeight = '36px';
        thumb.style.borderRadius = '4px';
        thumb.style.border = '1px solid #ddd';

        const name = document.createElement('span');
        name.className = 'seq-params';
        name.style.flex = '1';
        name.style.overflow = 'hidden';
        name.style.textOverflow = 'ellipsis';
        name.style.whiteSpace = 'nowrap';
        name.textContent = item.name;

        const moveUp = document.createElement('button');
        moveUp.type = 'button';
        moveUp.className = 'btn-remove-seq';
        moveUp.textContent = '▲';
        moveUp.title = '上移该帧';
        moveUp.disabled = index === 0;
        moveUp.setAttribute('aria-label', `上移第 ${index + 1} 帧`);
        moveUp.addEventListener('click', () => moveFourierSeqFrame(item.id, -1));

        const moveDown = document.createElement('button');
        moveDown.type = 'button';
        moveDown.className = 'btn-remove-seq';
        moveDown.textContent = '▼';
        moveDown.title = '下移该帧';
        moveDown.disabled = index === FourierSeqState.frames.length - 1;
        moveDown.setAttribute('aria-label', `下移第 ${index + 1} 帧`);
        moveDown.addEventListener('click', () => moveFourierSeqFrame(item.id, 1));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-remove-seq';
        remove.textContent = '✖';
        remove.title = '移除该帧';
        remove.setAttribute('aria-label', '移除该帧');
        remove.addEventListener('click', () => removeFourierSeqFrame(item.id));

        row.append(order, thumb, name, moveUp, moveDown, remove);
        listEl.append(row);
    });

    updateFourierSeqStatus();
}

function moveFourierSeqFrame(id, delta) {
    const currentIndex = FourierSeqState.frames.findIndex(item => item.id === id);
    if (currentIndex < 0) return;
    const targetIndex = currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= FourierSeqState.frames.length) return;

    stopFourierSeq(true);

    const frames = FourierSeqState.frames;
    [frames[currentIndex], frames[targetIndex]] = [frames[targetIndex], frames[currentIndex]];

    // 已批量模拟时同步重排强度帧，保持相位帧与强度帧一一对应，无需重新模拟
    if (FourierSeqState.simulated && FourierSeqState.simFrames.length === frames.length) {
        const simFrames = FourierSeqState.simFrames;
        [simFrames[currentIndex], simFrames[targetIndex]] =
            [simFrames[targetIndex], simFrames[currentIndex]];
    } else {
        setFourierSeqSimulated(false);
    }

    renderFourierSeqList();
}

function addFourierSeqFrame(image, name) {
    if (FourierSeqState.frames.length >= FOURIER_SEQ_MAX_FRAMES) {
        showNotification(`序列最多 ${FOURIER_SEQ_MAX_FRAMES} 帧`, 'warning');
        return false;
    }
    stopFourierSeq(true);
    setFourierSeqSimulated(false);
    FourierSeqState.frames.push({ id: Date.now() + Math.random(), image, name });
    renderFourierSeqList();
    return true;
}

function addCurrentPhaseToFourierSeq() {
    const phaseImg = document.getElementById('phase_image');
    if (!phaseImg || !phaseImg.src || phaseImg.style.display === 'none') {
        showNotification('请先生成或上传相位图', 'warning');
        return;
    }
    if (addFourierSeqFrame(phaseImg.src, '当前相位图')) {
        showNotification('已添加为序列帧', 'success');
    }
}

function handleFourierSeqUpload(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    let queued = 0;
    let pending = files.length;
    files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (addFourierSeqFrame(e.target.result, file.name)) queued++;
            pending--;
            if (pending === 0 && queued > 0) {
                showNotification(`已添加 ${queued} 帧到序列`, 'success');
            }
        };
        reader.readAsDataURL(file);
    });
}

function removeFourierSeqFrame(id) {
    stopFourierSeq(true);
    setFourierSeqSimulated(false);
    FourierSeqState.frames = FourierSeqState.frames.filter(item => item.id !== id);
    renderFourierSeqList();
}

function clearFourierSeq() {
    if (FourierSeqState.frames.length === 0) return;
    stopFourierSeq(true);
    setFourierSeqSimulated(false);
    FourierSeqState.frames = [];
    renderFourierSeqList();
    resetFourierSeqPlayer();
    showNotification('序列已清空', 'info');
}

function resetFourierSeqPlayer() {
    const img = document.getElementById('fourier_seq_player_img');
    const placeholder = document.getElementById('fourier_seq_player_placeholder');
    img.style.display = 'none';
    img.src = '';
    placeholder.style.display = '';
    document.getElementById('fourier_seq_frame_label').textContent = '帧 -/-';
}

function getFourierSeqSimParams() {
    return {
        illumination_type: document.getElementById('fourier_illumination_type').value,
        beam_radius: parseFloat(document.getElementById('fourier_beam_radius').value),
        width: parseInt(document.getElementById('fourier_width').value),
        height: parseInt(document.getElementById('fourier_height').value),
        colormap: document.getElementById('fourier_colormap').value
    };
}

async function runFourierSeqSimulation() {
    if (FourierSeqState.frames.length === 0) {
        showNotification('请先添加序列帧', 'warning');
        return;
    }

    stopFourierSeq(true);
    showLoading(true);
    const simBtn = document.getElementById('fourier_seq_sim_btn');
    simBtn.disabled = true;
    const progressEl = document.getElementById('fourier_seq_progress');
    progressEl.textContent = `正在批量模拟 ${FourierSeqState.frames.length} 帧...`;

    try {
        const response = await fetch('/api/simulate/fourier/sequence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phase_images: FourierSeqState.frames.map(f => f.image),
                ...getFourierSeqSimParams()
            })
        });

        const data = await response.json();
        if (!data.success) throw new Error(data.error || '批量模拟失败');

        FourierSeqState.simFrames = data.frames;
        FourierSeqState.simColormap = data.colormap;
        setFourierSeqSimulated(true);

        // 需求：批量模拟后同步更新模块中的彩色/对数/原始强度分布面板
        syncFourierResultFromSequence(0);

        const means = data.frames.map(f => f.mean_intensity);
        const meanOfMeans = (means.reduce((a, b) => a + b, 0) / means.length).toFixed(4);
        progressEl.textContent =
            `✅ 模拟完成：${data.frame_count} 帧（colormap: ${data.colormap}，照明: ${data.illumination_type}），分布面板已同步`;
        document.getElementById('fourier_seq_stats').textContent =
            `帧平均强度均值 ${meanOfMeans}，分布面板显示序列第 1 帧，可用选择器切换帧或播放/导出 GIF。`;
        showNotification(`序列模拟完成，共 ${data.frame_count} 帧`, 'success');
    } catch (error) {
        console.error('序列模拟错误:', error);
        progressEl.textContent = '❌ 模拟失败：' + error.message;
        showNotification('序列模拟失败: ' + error.message, 'error');
    } finally {
        showLoading(false);
        simBtn.disabled = false;
    }
}

function getFourierSeqPlaylist() {
    const mode = document.getElementById('fourier_seq_play_mode').value;
    if (mode === 'phase') {
        return FourierSeqState.frames.map((frame, index) => ({
            image: frame.image,
            label: `相位帧 ${index + 1}/${FourierSeqState.frames.length}`
        }));
    }
    if (!FourierSeqState.simulated || FourierSeqState.simFrames.length === 0) {
        return null;
    }
    return FourierSeqState.simFrames.map((frame, index) => ({
        image: frame.intensity_color,
        label: `强度帧 ${index + 1}/${FourierSeqState.simFrames.length} (峰值 ${frame.peak_intensity.toFixed(3)})`
    }));
}

function showFourierSeqFrame(frame) {
    const img = document.getElementById('fourier_seq_player_img');
    const placeholder = document.getElementById('fourier_seq_player_placeholder');
    img.src = frame.image;
    img.style.display = 'block';
    placeholder.style.display = 'none';
    document.getElementById('fourier_seq_frame_label').textContent = frame.label;
}

function onFourierSeqModeChange() {
    if (FourierSeqState.isPlaying) stopFourierSeq();
    resetFourierSeqPlayer();
}

function playFourierSeq() {
    if (FourierSeqState.isPlaying) return;

    const playlist = getFourierSeqPlaylist();
    if (!playlist) {
        showNotification('请先批量模拟序列（或切换到相位图模式）', 'warning');
        return;
    }
    if (playlist.length === 0) {
        showNotification('序列为空，请先添加帧', 'warning');
        return;
    }

    const interval = Math.max(
        50, parseInt(document.getElementById('fourier_seq_interval').value, 10) || 300
    );
    const loop = document.getElementById('fourier_seq_loop').checked;
    if (FourierSeqState.playIndex >= playlist.length) FourierSeqState.playIndex = 0;

    const advance = () => {
        const current = getFourierSeqPlaylist();
        if (!current || current.length === 0) {
            stopFourierSeq(true);
            return;
        }
        if (FourierSeqState.playIndex >= current.length) {
            if (loop) {
                FourierSeqState.playIndex = 0;
            } else {
                stopFourierSeq(true);
                return;
            }
        }
        showFourierSeqFrame(current[FourierSeqState.playIndex]);
        FourierSeqState.playIndex++;
    };

    advance();
    FourierSeqState.playTimer = setInterval(advance, interval);
    FourierSeqState.isPlaying = true;
    document.getElementById('fourier_seq_play_btn').disabled = true;
    document.getElementById('fourier_seq_pause_btn').disabled = false;
    showNotification('序列播放已开始', 'info');
}

function pauseFourierSeq() {
    if (FourierSeqState.playTimer) {
        clearInterval(FourierSeqState.playTimer);
        FourierSeqState.playTimer = null;
        FourierSeqState.isPlaying = false;
        document.getElementById('fourier_seq_play_btn').disabled = false;
        document.getElementById('fourier_seq_pause_btn').disabled = true;
        showNotification('序列播放已暂停', 'info');
    }
}

function stopFourierSeq(silent = false) {
    if (FourierSeqState.playTimer) {
        clearInterval(FourierSeqState.playTimer);
        FourierSeqState.playTimer = null;
    }
    const wasPlaying = FourierSeqState.isPlaying;
    FourierSeqState.isPlaying = false;
    FourierSeqState.playIndex = 0;
    document.getElementById('fourier_seq_play_btn').disabled = false;
    document.getElementById('fourier_seq_pause_btn').disabled = true;
    if (wasPlaying && !silent) showNotification('序列播放已停止', 'info');
}

async function exportFourierSeqGif() {
    if (FourierSeqState.frames.length === 0) {
        showNotification('请先添加序列帧', 'warning');
        return;
    }

    showLoading(true);
    const gifBtn = document.getElementById('fourier_seq_gif_btn');
    gifBtn.disabled = true;

    try {
        const response = await fetch('/api/simulate/fourier/export-gif', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phase_images: FourierSeqState.frames.map(f => f.image),
                ...getFourierSeqSimParams(),
                frame_duration_ms: Math.max(
                    20, parseInt(document.getElementById('fourier_seq_interval').value, 10) || 200
                ),
                intensity_mode: 'color'
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `导出失败 (${response.status})`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `fourier_sequence_${Date.now()}.gif`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        showNotification('GIF 导出已开始', 'success');
    } catch (error) {
        console.error('GIF导出错误:', error);
        showNotification('GIF 导出失败: ' + error.message, 'error');
    } finally {
        showLoading(false);
        gifBtn.disabled = FourierSeqState.frames.length === 0;
    }
}

// ==================== 历史记录 ====================
function addToHistory() {
    loadHistory();
}

function loadHistory() {
    fetch('/api/history')
        .then(response => {
            if (!response.ok) throw new Error('历史记录加载失败');
            return response.json();
        })
        .then(data => {
            if (!data.success || !Array.isArray(data.history)) throw new Error('历史记录格式无效');
            AppState.history = data.history;
            renderHistory(data.history);
        })
        .catch(error => {
            AppState.history = [];
            renderHistory([]);
            console.error('加载历史失败:', error);
        });
}

function formatHistorySummary(item) {
    const focus = Number(item.focus_mm);
    const wavelength = Number(item.wavelength_nm);
    if (Number.isFinite(focus) && focus > 0 && Number.isFinite(wavelength) && wavelength > 0) {
        return 'f=' + focus + 'mm, λ=' + wavelength + 'nm';
    }
    return typeof item.config_name === 'string' && item.config_name
        ? item.config_name
        : '历史记录 #' + item.id;
}

function createHistoryEntry(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-entry';
    button.setAttribute('aria-label', '加载历史相位图: ' + formatHistorySummary(item));
    const label = document.createElement('span');
    label.textContent = formatHistorySummary(item);
    const timestamp = document.createElement('time');
    timestamp.textContent = typeof item.created_at === 'string' ? item.created_at : '';
    button.append(label, timestamp);
    button.addEventListener('click', () => loadHistoryOutput(item));
    return button;
}

function renderHistory(history) {
    const historyList = document.getElementById('history_list');
    const recentList = document.getElementById('recent_patterns');
    if (!historyList || !recentList) return;
    historyList.replaceChildren();
    recentList.replaceChildren();
    if (history.length === 0) {
        const emptyHistory = document.createElement('div');
        emptyHistory.className = 'history-empty';
        emptyHistory.textContent = '暂无生成历史';
        historyList.append(emptyHistory);
        const emptyRecent = document.createElement('li');
        emptyRecent.className = 'recent-empty';
        emptyRecent.textContent = '暂无生成历史';
        recentList.append(emptyRecent);
        return;
    }

    history.slice(0, 5).forEach(item => {
        historyList.append(createHistoryEntry(item));
        const listItem = document.createElement('li');
        const recentEntry = createHistoryEntry(item);
        recentEntry.className = 'recent-pattern-entry';
        const timestamp = recentEntry.querySelector('time');
        timestamp.className = 'pattern-time';
        const label = recentEntry.querySelector('span');
        label.className = 'pattern-name';
        listItem.append(recentEntry);
        recentList.append(listItem);
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法读取历史相位图'));
        reader.readAsDataURL(blob);
    });
}

async function loadHistoryOutput(item) {
    const storedPath = typeof item?.output_file === 'string' ? item.output_file : '';
    const filename = storedPath.replace(/\\/g, '/').split('/').pop();
    if (!filename || filename === '.' || filename === '..' ||
        !/^[A-Za-z0-9_.-]+\.(bmp|png|jpe?g|webp|tiff?)$/i.test(filename)) {
        showNotification('历史记录中的输出文件名无效', 'error');
        return;
    }

    try {
        const response = await fetch('/api/download/' + encodeURIComponent(filename));
        if (!response.ok) throw new Error('输出文件不存在或已被移除');
        const imageData = await blobToDataUrl(await response.blob());
        const image = await loadPaintImage(imageData);
        const parametersRestored = restoreHistoryParameters(item.parameters);
        displayPhaseImage(imageData);
        AppState.currentPatternType = parametersRestored
            ? item.parameters.pattern_type
            : 'history';
        AppState.currentImageData = {
            image: imageData,
            filename,
            paramsDescription: formatHistorySummary(item)
        };
        document.getElementById('download_btn').disabled = false;
        document.getElementById('info_focus').textContent = Number(item.focus_mm) > 0
            ? item.focus_mm + ' mm'
            : (item.config_name || '历史记录');
        document.getElementById('info_wavelength').textContent = Number(item.wavelength_nm) > 0
            ? item.wavelength_nm + ' nm'
            : 'N/A';
        document.getElementById('info_resolution').textContent =
            image.naturalWidth + ' × ' + image.naturalHeight;
        document.getElementById('info_time').textContent = item.created_at || '';
        showNotification(parametersRestored
            ? '历史相位图和可用参数已恢复；源图像不保存在历史记录中'
            : '历史相位图已加载；此记录没有可恢复的参数快照', 'info');
    } catch (error) {
        showNotification('历史相位图加载失败: ' + error.message, 'error');
    }
}

function restoreHistoryParameters(snapshot) {
    if (!snapshot || snapshot.version !== 1 || typeof snapshot.pattern_type !== 'string' ||
        !snapshot.parameters || typeof snapshot.parameters !== 'object' ||
        Array.isArray(snapshot.parameters)) return false;
    const values = snapshot.parameters;
    const mapped = {};
    const take = (controlId, ...keys) => {
        const key = keys.find(candidate => Object.prototype.hasOwnProperty.call(values, candidate));
        if (!key) return;
        const value = values[key];
        mapped[controlId] = value === null ? '' :
            (typeof value === 'boolean' ? value : String(value));
    };
    const dimensions = (widthId, heightId) => {
        take(widthId, 'width', 'x_pixels');
        take(heightId, 'height', 'y_pixels');
    };

    switch (snapshot.pattern_type) {
        case 'fresnel':
            take('focus_mm', 'focus_mm', 'focal_length');
            take('wavelength_nm', 'wavelength_nm', 'wavelength');
            take('x_pixels', 'x_pixels', 'width');
            take('y_pixels', 'y_pixels', 'height');
            take('pitch_mode');
            take('rotation_degree');
            take('offset_x');
            take('offset_y');
            take('scale_factor');
            break;
        case 'fresnel_three_spots':
        case 'three_spots': {
            const prefix = snapshot.pattern_type === 'three_spots' ? 'tsn' : 'three_spot';
            take(`${prefix}_focus`, 'focal_length');
            take(`${prefix}_wavelength`, 'wavelength');
            take(`${prefix}_spacing`, 'spot_spacing');
            take(`${prefix}_count`, 'spot_count');
            take(`${prefix}_pixel_size`, 'pixel_size_um');
            take(`${prefix}_algorithm`, 'algorithm');
            take(`${prefix}_beam_diameter`, 'incident_beam_diameter_mm');
            take(`${prefix}_radius`, 'spot_radius_mm');
            take(`${prefix}_iterations`, 'iterations');
            take(`${prefix}_phase_direction`, 'phase_direction');
            dimensions(`${prefix}_width`, `${prefix}_height`);
            if (snapshot.pattern_type === 'fresnel_three_spots') {
                take('three_spot_algorithm', 'algorithm');
            }
            break;
        }
        case 'axicon':
            take('axicon_radius', 'radius');
            dimensions('axicon_width', 'axicon_height');
            break;
        case 'cylindrical':
            take('cylindrical_focal_length', 'focal_length');
            take('cylindrical_wavelength', 'wavelength');
            take('cylindrical_pixel_size', 'pixel_size', 'pixel_size_um');
            if (mapped.cylindrical_pixel_size !== undefined) {
                mapped.cylindrical_pixel_size = String(Number(mapped.cylindrical_pixel_size) * 1000);
            }
            take('cylindrical_angle', 'angle');
            dimensions('cylindrical_width', 'cylindrical_height');
            break;
        case 'blaze':
        case 'sine': {
            const prefix = snapshot.pattern_type;
            take(`${prefix}_period`, 'period');
            take(`${prefix}_angle`, 'angle');
            dimensions(`${prefix}_width`, `${prefix}_height`);
            break;
        }
        case 'vortex':
            take('vortex_lnumber', 'lnumber');
            dimensions('vortex_width', 'vortex_height');
            break;
        case 'random':
            take('random_seed', 'seed');
            dimensions('random_width', 'random_height');
            break;
        case 'divide':
            take('divide_gray1', 'grayvalue1');
            take('divide_gray2', 'grayvalue2');
            dimensions('divide_width', 'divide_height');
            break;
        case 'cross':
            take('cross_background_phase', 'background_phase');
            take('cross_stripe_phase', 'stripe_phase');
            take('cross_stripe_width', 'stripe_width');
            take('cross_stripe_spacing', 'stripe_spacing');
            take('cross_stripe_number', 'stripe_number');
            take('cross_intersection_phase', 'intersection_phase');
            dimensions('cross_width', 'cross_height');
            break;
        case 'double_ring':
            dimensions('double_ring_width', 'double_ring_height');
            take('double_ring_inner_radius', 'inner_radius');
            take('double_ring_outer_radius', 'outer_radius');
            take('double_ring_inner_width', 'inner_width');
            take('double_ring_outer_width', 'outer_width');
            take('double_ring_inner_intensity', 'inner_intensity');
            take('double_ring_outer_intensity', 'outer_intensity');
            take('double_ring_between_intensity', 'between_intensity');
            take('double_ring_iterations', 'iterations');
            break;
        case 'cgh':
            take('cgh_algorithm', 'algorithm');
            take('cgh_light_shape', 'light_shape');
            take('cgh_light_size', 'light_size');
            take('cgh_repetition', 'iterations');
            take('cgh_width', 'width');
            take('cgh_height', 'height');
            take('cgh_gaussian_spots', 'gaussian_spots');
            take('cgh_spot_radius', 'spot_radius');
            break;
        case 'converter':
            take('converter_width', 'width');
            take('converter_height', 'height');
            take('converter_grayscale', 'grayscale');
            break;
        default:
            return false;
    }

    let controls;
    let spotArrayState = null;
    try {
        controls = validateProjectControls(mapped);
        if (snapshot.pattern_type === 'fresnel_three_spots' && Array.isArray(values.target_spots)) {
            const controlValues = Object.fromEntries(
                controls.map(([control, value]) => [control.id, value])
            );
            const spotSnapshot = {
                customized: true,
                legacyAlgorithm: values.legacy_algorithm || 'uniform_grating',
                spots: values.target_spots
            };
            spotArrayState = validateSpotArrayProjectState(spotSnapshot, controlValues);
        }
    } catch (error) {
        console.warn('历史参数快照无法恢复:', error);
        return false;
    }

    controls.forEach(([control, value]) => {
        if (control.type === 'checkbox') control.checked = value;
        else control.value = value;
    });
    if (Object.prototype.hasOwnProperty.call(mapped, 'focus_mm')) {
        document.getElementById('focus_slider').value = document.getElementById('focus_mm').value;
    }
    if (Object.prototype.hasOwnProperty.call(mapped, 'rotation_degree')) {
        document.getElementById('rotation_slider').value = document.getElementById('rotation_degree').value;
    }
    if (Object.prototype.hasOwnProperty.call(mapped, 'wavelength_nm')) {
        setWavelength(document.getElementById('wavelength_nm').value);
    }
    if (spotArrayState && typeof restoreSpotArrayProjectState === 'function') {
        restoreSpotArrayProjectState({
            customized: true,
            legacyAlgorithm: values.legacy_algorithm || 'uniform_grating',
            spots: values.target_spots
        }, spotArrayState);
    }
    return true;
}

// ==================== 通知系统 ====================
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 60px;
        right: 20px;
        padding: 15px 25px;
        border-radius: 6px;
        color: white;
        font-weight: 600;
        z-index: 10000;
        animation: slideIn 0.5s ease;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        max-width: 300px;
    `;

    const colors = {
        success: 'linear-gradient(135deg, #00aa00 0%, #008800 100%)',
        error: 'linear-gradient(135deg, #cc0000 0%, #aa0000 100%)',
        warning: 'linear-gradient(135deg, #ff9900 0%, #cc7700 100%)',
        info: 'linear-gradient(135deg, #0066cc 0%, #004d99 100%)'
    };

    notification.style.background = colors[type] || colors.info;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.5s ease';
        setTimeout(() => notification.remove(), 500);
    }, 3000);
}

// 添加CSS动画
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);
