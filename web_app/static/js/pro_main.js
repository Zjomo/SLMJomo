/**
 * LCOS-SLM 专业控制面板 - 前端交互逻辑
 * 模拟官方SLM软件功能
 */

// ==================== 全局状态管理 ====================
const AppState = {
    currentImageData: null,
    currentPatternType: null,
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
    initializeCGHUpload();
    initializeCGHShapeHint();
    initializeConverterUpload();
    toggleThreeSpotOptimization();
    initializeThreeSpotDammannInfo();
    initializeDoubleRing();
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
    showLoading(true);
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
        showLoading(false);
    }
}

// ==================== 通用图案生成函数 ====================
async function generatePattern(patternType) {
    AppState.currentPatternType = patternType;
    showLoading(true);

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
                iterations: parseInt(document.getElementById('three_spot_iterations').value),
                phase_direction: document.getElementById('three_spot_phase_direction').value,
                width: parseInt(document.getElementById('three_spot_width').value),
                height: parseInt(document.getElementById('three_spot_height').value)
            };
            break;

        case 'axicon':
            params = {
                radius: parseFloat(document.getElementById('axicon_radius').value),
                width: parseInt(document.getElementById('axicon_width').value),
                height: parseInt(document.getElementById('axicon_height').value)
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
            showLoading(false);
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
        showLoading(false);
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

    if (type === 'fresnel' || type === 'fresnel_three_spots') {
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
        params: getCurrentParamsDescription()
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
            return `${document.getElementById('three_spot_count').value}点, f=${document.getElementById('three_spot_focus').value}mm, d=${document.getElementById('three_spot_spacing').value}mm`;
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

    if (AppState.sequenceList.length === 0) {
        listEl.innerHTML = '<div class="sequence-empty"><p>暂无序列，请添加图案</p></div>';
        return;
    }

    listEl.innerHTML = AppState.sequenceList.map((item, index) => `
        <div class="sequence-item" data-id="${item.id}">
            <span class="seq-index">#${index + 1}</span>
            <span class="seq-params">${item.patternType || 'pattern'}: ${item.params}</span>
            <button class="btn-remove-seq" onclick="removeFromSequence(${item.id})">✖</button>
        </div>
    `).join('');
}

function removeFromSequence(id) {
    AppState.sequenceList = AppState.sequenceList.filter(item => item.id !== id);
    updateSequenceList();
}

function playSequence() {
    if (AppState.sequenceList.length === 0) {
        showNotification('序列为空，请先添加图案', 'warning');
        return;
    }

    AppState.isPlaying = true;
    AppState.sequenceIndex = 0;

    const interval = parseInt(document.getElementById('play_interval').value) || 1000;
    const loop = document.getElementById('loop_play').checked;

    AppState.playInterval = setInterval(() => {
        if (AppState.sequenceIndex >= AppState.sequenceList.length) {
            if (loop) {
                AppState.sequenceIndex = 0;
            } else {
                stopSequence();
                return;
            }
        }

        const item = AppState.sequenceList[AppState.sequenceIndex];
        displayPhaseImage(item.image);
        AppState.sequenceIndex++;

        // 更新播放状态
        document.getElementById('play_btn').disabled = true;
        document.getElementById('pause_btn').disabled = false;
    }, interval);

    showNotification('序列播放已开始', 'info');
}

function pauseSequence() {
    if (AppState.playInterval) {
        clearInterval(AppState.playInterval);
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
        AppState.isPlaying = false;
        AppState.sequenceIndex = 0;

        document.getElementById('play_btn').disabled = false;
        document.getElementById('pause_btn').disabled = true;

        showNotification('序列播放已停止', 'info');
    }
}

// ==================== 设备连接 ====================
function connectDevice() {
    // 模拟设备连接
    AppState.deviceConnected = true;

    const statusEl = document.getElementById('device_status');
    statusEl.innerHTML = `
        <span class="status-icon">✅</span>
        <span class="status-text">已连接</span>
    `;

    document.getElementById('device_name').textContent = 'LCOS-SLM X15223';

    showNotification('设备连接成功', 'success');
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

    // 模拟显示到SLM
    showNotification('相位图已发送到SLM显示器', 'success');
}

// ==================== 下载图像 ====================
function downloadImage() {
    if (AppState.currentImageData && AppState.currentImageData.filename) {
        const link = document.createElement('a');
        link.href = `/api/download/${AppState.currentImageData.filename}`;
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

function toggleModule(moduleId) {
    const module = document.getElementById(moduleId);
    if (module) {
        module.classList.toggle('collapsed');
    }
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
            document.getElementById('three_spot_iterations').value = 30;
            document.getElementById('three_spot_phase_direction').value = 'standard';
            document.getElementById('three_spot_width').value = 1272;
            document.getElementById('three_spot_height').value = 1024;
            toggleThreeSpotOptimization();
            showNotification('多点聚焦参数已重置', 'info');
            break;

        case 'axicon':
            document.getElementById('axicon_radius').value = 100;
            document.getElementById('axicon_width').value = 512;
            document.getElementById('axicon_height').value = 512;
            showNotification('轴棱锥透镜参数已重置', 'info');
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
                AppState.cghData.targetImage = e.target.result;
                displayCGHTargetImage(e.target.result);
                generateLightShapePreview();
            };
            reader.readAsDataURL(file);
        }
    });
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

    AppState.currentPatternType = 'cgh';
    showLoading(true);

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
        showLoading(false);
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

function toggleThreeSpotOptimization() {
    const algorithm = document.getElementById('three_spot_algorithm');
    const optimization = document.getElementById('three_spot_optimization_params');
    const iterations = document.getElementById('three_spot_iterations_container');
    const dammann = document.getElementById('three_spot_dammann_params');
    const uniform = document.getElementById('three_spot_uniform_params');
    if (!algorithm || !optimization || !iterations || !dammann || !uniform) return;

    const spotCount = parseInt(document.getElementById('three_spot_count').value);
    const dammannOption = algorithm.querySelector('option[value="dammann"]');
    dammannOption.disabled = spotCount !== 3;
    if (algorithm.value === 'dammann' && spotCount !== 3) {
        algorithm.value = 'uniform_grating';
    }

    const targetPreview = document.querySelector('.three-spot-target');
    if (targetPreview && Number.isInteger(spotCount) && spotCount >= 2 && spotCount <= 15) {
        targetPreview.innerHTML = '<span></span>'.repeat(spotCount);
        targetPreview.setAttribute('aria-label', `${spotCount} 个水平等间距焦点`);
    }

    const usesBeamModel = algorithm.value === 'gaussian_wgs' || algorithm.value === 'dammann';
    optimization.style.display = usesBeamModel ? 'block' : 'none';
    iterations.style.display = algorithm.value === 'gaussian_wgs' ? 'block' : 'none';
    dammann.style.display = algorithm.value === 'dammann' ? 'block' : 'none';
    uniform.style.display = algorithm.value === 'uniform_grating' ? 'block' : 'none';
    updateThreeSpotDammannInfo();
}

function initializeThreeSpotDammannInfo() {
    ['three_spot_focus', 'three_spot_wavelength', 'three_spot_spacing',
        'three_spot_pixel_size', 'three_spot_width', 'three_spot_count']
        .forEach(id => {
            const input = document.getElementById(id);
            if (input) input.addEventListener('input', updateThreeSpotDammannInfo);
        });
}

function updateThreeSpotDammannInfo() {
    const output = document.getElementById('three_spot_dammann_period');
    if (!output) return;
    const focalLength = parseFloat(document.getElementById('three_spot_focus').value);
    const wavelength = parseFloat(document.getElementById('three_spot_wavelength').value);
    const spacing = parseFloat(document.getElementById('three_spot_spacing').value);
    const pixelSize = parseFloat(document.getElementById('three_spot_pixel_size').value);
    const width = parseInt(document.getElementById('three_spot_width').value);
    const spotCount = parseInt(document.getElementById('three_spot_count').value);
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
    const uniformInfo = document.getElementById('three_spot_uniform_sampling');
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

    showNotification('CGH已发送到SLM显示器', 'success');
}

function loadPatternFromMain() {
    showNotification('从主程序加载图案功能开发中...', 'info');
}

function loadCGHFromMain() {
    showNotification('从主程序加载CGH功能开发中...', 'info');
}

function returnToMain() {
    scrollToSection('fresnel');
    showNotification('已返回主程序', 'info');
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
    showNotification('预设保存功能开发中...', 'info');
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

function switchTab(tabName) {
    // 切换菜单激活状态
    document.querySelectorAll('.menu-item').forEach(item => {
        item.classList.remove('active');
    });
    event.target.classList.add('active');

    showNotification(`切换到 ${tabName} 页面`, 'info');
}

function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // 更新左侧导航激活状态
    document.querySelectorAll('.nav-list li').forEach(li => {
        li.classList.remove('active');
    });

    const activeNav = document.querySelector(`.nav-list li[onclick="scrollToSection('${sectionId}')"]`);
    if (activeNav) {
        activeNav.classList.add('active');
    }
}

function startWorkflow(action) {
    showNotification(`${action} 功能开发中...`, 'info');
}

function loadRecentPattern(patternId) {
    showNotification(`加载预设: ${patternId}`, 'info');
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

// ==================== 历史记录 ====================
function addToHistory(params) {
    const historyList = document.getElementById('history_list');
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    const focus = params.focus_mm ?? params.focal_length;
    const wavelength = params.wavelength_nm ?? params.wavelength;
    const summary = Number.isFinite(focus) && Number.isFinite(wavelength)
        ? `f=${focus}mm, λ=${wavelength}nm`
        : (AppState.currentPatternType || 'pattern');
    historyItem.innerHTML = `
        <div>${summary}</div>
        <div>${new Date().toLocaleTimeString('zh-CN')}</div>
    `;
    historyList.insertBefore(historyItem, historyList.firstChild);

    // 保持最多10条记录
    while (historyList.children.length > 10) {
        historyList.removeChild(historyList.lastChild);
    }
}

function loadHistory() {
    // 从服务器加载历史记录
    fetch('/api/history')
        .then(response => response.json())
        .then(data => {
            if (data.success && data.history.length > 0) {
                const historyList = document.getElementById('history_list');
                historyList.innerHTML = data.history.slice(0, 5).map(item => `
                    <div class="history-item">
                        <div>${item.focus_mm > 0 && item.wavelength_nm > 0
                            ? `f=${item.focus_mm}mm, λ=${item.wavelength_nm}nm`
                            : item.config_name}</div>
                        <div>${item.created_at}</div>
                    </div>
                `).join('');
            }
        })
        .catch(error => console.error('加载历史失败:', error));
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
