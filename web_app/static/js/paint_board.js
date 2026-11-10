const PaintBoard = {
    strokes: [],
    clips: [],
    mode: 'brush',
    drawing: false,
    currentStroke: null,
    phaseImage: null,
    phaseData: null,
    phaseFilename: null,
    playbackTimer: null,
    currentTimeMs: 0
};

document.addEventListener('DOMContentLoaded', initializePaintBoard);

function initializePaintBoard() {
    const canvas = document.getElementById('paint_source_canvas');
    if (!canvas) return;

    PaintBoard.canvas = canvas;
    PaintBoard.context = canvas.getContext('2d');
    PaintBoard.phasePreviewContext = document.getElementById('paint_phase_preview')
        .getContext('2d', { willReadFrequently: true });
    paintCanvasBackground(PaintBoard.context, canvas.width, canvas.height);
    initializePaintPointerEvents();

    const brushSize = document.getElementById('paint_brush_size');
    brushSize.addEventListener('input', () => {
        document.getElementById('paint_brush_size_value').textContent = `${brushSize.value} px`;
    });
    document.getElementById('paint_fps').addEventListener('input', updatePaintTimeline);
    document.getElementById('paint_timeline').addEventListener('input', event => {
        const count = getPaintFrameCount();
        const progress = count <= 1 ? 0 : Number(event.target.value) / (count - 1);
        PaintBoard.currentTimeMs = getPaintTotalDuration() * progress;
        renderPaintBoardFrame(PaintBoard.currentTimeMs);
        updatePaintFrameLabel(Number(event.target.value));
    });
    document.getElementById('paint_job_file').addEventListener('change', loadPaintJobFromFile);
    updatePaintTimeline();
}

function initializePaintPointerEvents() {
    const canvas = PaintBoard.canvas;
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        stopPaintPreview();
        invalidatePaintHologram();
        canvas.setPointerCapture(event.pointerId);
        const point = getPaintPoint(event);
        PaintBoard.currentStroke = {
            mode: PaintBoard.mode,
            size: Number(document.getElementById('paint_brush_size').value),
            points: [point]
        };
        PaintBoard.strokes.push(PaintBoard.currentStroke);
        PaintBoard.drawing = true;
        drawPaintSegment(PaintBoard.context, point, point, PaintBoard.currentStroke);
        updatePaintStrokeCount();
    });
    canvas.addEventListener('pointermove', event => {
        if (!PaintBoard.drawing || !PaintBoard.currentStroke) return;
        event.preventDefault();
        const point = getPaintPoint(event);
        const points = PaintBoard.currentStroke.points;
        const previous = points[points.length - 1];
        points.push(point);
        drawPaintSegment(PaintBoard.context, previous, point, PaintBoard.currentStroke);
    });
    const finishStroke = event => {
        if (!PaintBoard.drawing) return;
        PaintBoard.drawing = false;
        PaintBoard.currentStroke = null;
        if (event && canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }
    };
    canvas.addEventListener('pointerup', finishStroke);
    canvas.addEventListener('pointercancel', finishStroke);
    canvas.addEventListener('lostpointercapture', finishStroke);
}

function getPaintPoint(event) {
    const rect = PaintBoard.canvas.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(PaintBoard.canvas.width, (event.clientX - rect.left) * PaintBoard.canvas.width / rect.width)),
        y: Math.max(0, Math.min(PaintBoard.canvas.height, (event.clientY - rect.top) * PaintBoard.canvas.height / rect.height))
    };
}

function paintCanvasBackground(context, width, height) {
    context.fillStyle = '#050607';
    context.fillRect(0, 0, width, height);
}

function drawPaintSegment(context, from, to, stroke) {
    context.strokeStyle = stroke.mode === 'eraser' ? '#050607' : '#ffffff';
    context.fillStyle = context.strokeStyle;
    context.lineWidth = stroke.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(from.x, from.y, stroke.size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function redrawPaintBoard() {
    const context = PaintBoard.context;
    paintCanvasBackground(context, PaintBoard.canvas.width, PaintBoard.canvas.height);
    PaintBoard.strokes.forEach(stroke => {
        for (let i = 0; i < stroke.points.length; i++) {
            drawPaintSegment(context, stroke.points[i], stroke.points[i], stroke);
            if (i > 0) drawPaintSegment(context, stroke.points[i - 1], stroke.points[i], stroke);
        }
    });
    updatePaintStrokeCount();
}

function setPaintTool(mode) {
    if (!['brush', 'eraser'].includes(mode)) return;
    PaintBoard.mode = mode;
    document.querySelectorAll('.paint-tool').forEach(button => {
        button.classList.toggle('active', button.dataset.mode === mode);
    });
    PaintBoard.canvas.style.cursor = mode === 'eraser' ? 'cell' : 'crosshair';
}

function undoPaintStroke() {
    if (!PaintBoard.strokes.length) return;
    PaintBoard.strokes.pop();
    invalidatePaintHologram();
    redrawPaintBoard();
}

function clearPaintBoard() {
    if (!PaintBoard.strokes.length) return;
    stopPaintPreview();
    PaintBoard.strokes = [];
    invalidatePaintHologram();
    redrawPaintBoard();
    showNotification('绘图板已清空', 'info');
}

function updatePaintStrokeCount() {
    const count = document.getElementById('paint_stroke_count');
    if (count) count.textContent = `${PaintBoard.strokes.length} 笔`;
}

function invalidatePaintHologram() {
    PaintBoard.phaseImage = null;
    PaintBoard.phaseData = null;
    PaintBoard.phaseFilename = null;
    document.getElementById('paint_phase_status').textContent = '轨迹已更改，请重新生成';
    document.getElementById('paint_queue_btn').disabled = true;
    document.getElementById('paint_send_btn').disabled = true;
    const preview = document.getElementById('paint_phase_preview');
    paintCanvasBackground(preview.getContext('2d'), preview.width, preview.height);
}

function getPaintFps() {
    const value = Number(document.getElementById('paint_fps').value);
    return Math.max(1, Math.min(30, Number.isFinite(value) ? value : 10));
}

function getPaintClipDuration() {
    const value = Number(document.getElementById('paint_clip_duration').value);
    return Math.max(0.1, Math.min(10, Number.isFinite(value) ? value : 1)) * 1000;
}

function getPaintTotalDuration(clips = PaintBoard.clips) {
    return clips.reduce((total, clip) => total + clip.durationMs, 0);
}

function getPaintFrameCount(clips = PaintBoard.clips, fps = getPaintFps()) {
    if (!clips.length) return 1;
    return Math.max(1, Math.min(1800, Math.ceil(getPaintTotalDuration(clips) / 1000 * fps)));
}

function addPaintClip(type) {
    if (!['rotate', 'scale', 'move'].includes(type)) return;
    const value = type === 'rotate'
        ? Number(document.getElementById('paint_rotate_angle').value)
        : type === 'scale'
            ? Number(document.getElementById('paint_scale_factor').value)
            : {
                x: Number(document.getElementById('paint_move_x').value),
                y: Number(document.getElementById('paint_move_y').value)
            };
    const valid = type === 'move'
        ? Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) <= 256 && Math.abs(value.y) <= 256
        : Number.isFinite(value) && (type === 'rotate'
            ? value >= -360 && value <= 360
            : value >= 0.25 && value <= 4);
    if (!valid) {
        const message = type === 'rotate' ? '旋转角度须在 -360° 至 360° 之间'
            : type === 'scale' ? '缩放倍率须在 0.25 至 4 之间'
                : '平移距离须在 -256 至 256 px 之间';
        showNotification(message, 'warning');
        return;
    }
    const clip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        value,
        durationMs: getPaintClipDuration()
    };
    if (getPaintTotalDuration() + clip.durationMs > 60000) {
        showNotification('动画总时长不能超过 60 秒', 'warning');
        return;
    }
    PaintBoard.clips.push(clip);
    stopPaintPreview();
    renderPaintClips();
    updatePaintTimeline();
}

function removePaintClip(id) {
    PaintBoard.clips = PaintBoard.clips.filter(clip => clip.id !== id);
    stopPaintPreview();
    renderPaintClips();
    updatePaintTimeline();
}

function clearPaintClips() {
    if (!PaintBoard.clips.length) return;
    stopPaintPreview();
    PaintBoard.clips = [];
    PaintBoard.currentTimeMs = 0;
    renderPaintClips();
    updatePaintTimeline();
    renderPaintBoardFrame(0);
}

function renderPaintClips() {
    const list = document.getElementById('paint_clip_list');
    if (!PaintBoard.clips.length) {
        list.innerHTML = '<div class="paint-empty">添加平移、旋转或缩放片段以创建动画</div>';
        return;
    }
    list.replaceChildren(...PaintBoard.clips.map((clip, index) => {
        const row = document.createElement('div');
        row.className = 'paint-clip-row';
        const ordinal = document.createElement('span');
        ordinal.className = 'paint-clip-index';
        ordinal.textContent = `#${index + 1}`;
        const name = document.createElement('span');
        name.textContent = clip.type === 'rotate' ? '旋转' : clip.type === 'scale' ? '缩放' : '平移';
        const value = document.createElement('span');
        value.className = 'paint-clip-value';
        value.textContent = clip.type === 'rotate'
            ? `${clip.value}° · ${(clip.durationMs / 1000).toFixed(1)} s`
            : clip.type === 'scale'
                ? `×${clip.value.toFixed(2)} · ${(clip.durationMs / 1000).toFixed(1)} s`
                : `X ${clip.value.x}px · Y ${clip.value.y}px · ${(clip.durationMs / 1000).toFixed(1)} s`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'paint-clip-remove';
        remove.title = '删除片段';
        remove.textContent = '×';
        remove.addEventListener('click', () => removePaintClip(clip.id));
        row.append(ordinal, name, value, remove);
        return row;
    }));
}

function updatePaintTimeline() {
    const timeline = document.getElementById('paint_timeline');
    if (!timeline) return;
    const count = getPaintFrameCount();
    timeline.max = String(count - 1);
    timeline.value = String(Math.min(Number(timeline.value) || 0, count - 1));
    updatePaintFrameLabel(Number(timeline.value));
}

function updatePaintFrameLabel(frame) {
    const count = getPaintFrameCount();
    document.getElementById('paint_frame_label').textContent = `帧 ${Math.min(frame + 1, count)} / ${count}`;
}

function getPaintTransformAt(timeMs, clips = PaintBoard.clips) {
    let remaining = Math.max(0, timeMs);
    let angle = 0;
    let scale = 1;
    let x = 0;
    let y = 0;
    for (const clip of clips) {
        const progress = Math.min(1, remaining / clip.durationMs);
        if (clip.type === 'rotate') {
            angle = (angle + clip.value * progress) % 360;
        } else if (clip.type === 'scale') {
            scale = Math.max(0.1, Math.min(10, scale * Math.pow(clip.value, progress)));
        } else if (clip.type === 'move') {
            x += clip.value.x * progress;
            y += clip.value.y * progress;
        }
        if (remaining < clip.durationMs) break;
        remaining -= clip.durationMs;
    }
    return { angle, scale, x, y };
}

function drawTransformedImage(source, destination, angle, scale, x = 0, y = 0) {
    const context = destination.getContext('2d');
    const width = destination.width;
    const height = destination.height;
    paintCanvasBackground(context, width, height);
    if (!source) return;
    context.save();
    context.translate(width / 2 + x, height / 2 + y);
    context.rotate(angle * Math.PI / 180);
    context.scale(scale, scale);
    context.drawImage(source, -width / 2, -height / 2, width, height);
    context.restore();
}

function drawTranslatedPhase(source, destination, angle, scale, xPixels, yPixels) {
    drawTransformedImage(source, destination, angle, scale);
    if (!xPixels && !yPixels) return;
    const context = destination.getContext('2d');
    const frame = context.getImageData(0, 0, destination.width, destination.height);
    const width = destination.width;
    const height = destination.height;
    for (let y = 0; y < height; y++) {
        const yPhase = yPixels * y / height;
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const phase = frame.data[offset] / 255 + xPixels * x / width + yPhase;
            frame.data[offset] = frame.data[offset + 1] = frame.data[offset + 2] = Math.round(((phase % 1) + 1) % 1 * 255);
        }
    }
    context.putImageData(frame, 0, 0);
}

function renderPaintBoardFrame(timeMs) {
    const transform = getPaintTransformAt(timeMs);
    drawTransformedImage(PaintBoard.canvas, document.getElementById('paint_target_preview'), transform.angle, transform.scale, transform.x, transform.y);
    if (PaintBoard.phaseImage) {
        const phaseCanvas = document.getElementById('paint_phase_preview');
        drawTranslatedPhase(PaintBoard.phaseImage, phaseCanvas, transform.angle, 1 / transform.scale, transform.x, transform.y);
    }
    const count = getPaintFrameCount();
    const frame = Math.min(count - 1, Math.max(0, Math.round((getPaintTotalDuration() ? timeMs / getPaintTotalDuration() : 0) * (count - 1))));
    const timeline = document.getElementById('paint_timeline');
    if (timeline) timeline.value = String(frame);
    updatePaintFrameLabel(frame);
}

async function generatePaintHologram() {
    if (!PaintBoard.strokes.length) {
        showNotification('请先在画布上绘制目标轨迹', 'warning');
        return false;
    }
    const button = document.getElementById('paint_generate_btn');
    button.disabled = true;
    document.getElementById('paint_phase_status').textContent = 'GS 全息图计算中…';
    try {
        const response = await fetch('/api/cgh/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                target_image: PaintBoard.canvas.toDataURL('image/png'),
                algorithm: 'gs',
                light_shape: 'flat-square',
                light_size: 2,
                iterations: 30,
                width: 512,
                height: 512
            })
        });
        const data = await response.json();
        if (!response.ok || !data.success || !data.cgh_image) {
            throw new Error(data.error || '全息图生成失败');
        }
        const phaseImage = await loadPaintImage(data.cgh_image);
        PaintBoard.phaseImage = phaseImage;
        PaintBoard.phaseData = data.cgh_image;
        PaintBoard.phaseFilename = data.filename;
        document.getElementById('paint_phase_status').textContent = `全息图已生成 · ${data.info.width} × ${data.info.height}`;
        document.getElementById('paint_queue_btn').disabled = false;
        document.getElementById('paint_send_btn').disabled = false;
        renderPaintBoardFrame(PaintBoard.currentTimeMs);
        showNotification('GS 全息图已生成', 'success');
        return true;
    } catch (error) {
        document.getElementById('paint_phase_status').textContent = '生成失败';
        showNotification(`全息图生成失败：${error.message}`, 'error');
        return false;
    } finally {
        button.disabled = false;
    }
}

function loadPaintImage(source) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('无法读取相位图像'));
        image.src = source;
    });
}

async function playPaintPreview() {
    if (!PaintBoard.phaseImage && !await generatePaintHologram()) return;
    if (PaintBoard.playbackTimer) return;
    if (PaintBoard.currentTimeMs >= getPaintTotalDuration()) PaintBoard.currentTimeMs = 0;
    document.getElementById('paint_play_btn').disabled = true;
    document.getElementById('paint_pause_btn').disabled = false;
    const fps = getPaintFps();
    PaintBoard.playbackTimer = setInterval(() => {
        const duration = getPaintTotalDuration();
        if (!duration) {
            renderPaintBoardFrame(0);
            pausePaintPreview();
            return;
        }
        PaintBoard.currentTimeMs += 1000 / fps;
        if (PaintBoard.currentTimeMs >= duration) {
            if (document.getElementById('paint_loop').checked) {
                renderPaintBoardFrame(duration);
                PaintBoard.currentTimeMs = 0;
            } else {
                PaintBoard.currentTimeMs = duration;
                renderPaintBoardFrame(PaintBoard.currentTimeMs);
                pausePaintPreview();
                return;
            }
        }
        renderPaintBoardFrame(PaintBoard.currentTimeMs);
    }, 1000 / fps);
}

function pausePaintPreview() {
    if (PaintBoard.playbackTimer) {
        clearInterval(PaintBoard.playbackTimer);
        PaintBoard.playbackTimer = null;
    }
    document.getElementById('paint_play_btn').disabled = false;
    document.getElementById('paint_pause_btn').disabled = true;
}

function stopPaintPreview() {
    pausePaintPreview();
    PaintBoard.currentTimeMs = 0;
    const timeline = document.getElementById('paint_timeline');
    if (timeline) timeline.value = '0';
    if (PaintBoard.canvas) renderPaintBoardFrame(0);
}

function createPaintAnimationSnapshot() {
    const source = document.createElement('canvas');
    source.width = PaintBoard.canvas.width;
    source.height = PaintBoard.canvas.height;
    source.getContext('2d').drawImage(PaintBoard.canvas, 0, 0);
    const clips = PaintBoard.clips.map(clip => ({ ...clip }));
    const fps = getPaintFps();
    return {
        source,
        phaseImage: PaintBoard.phaseImage,
        clips,
        fps,
        durationMs: getPaintTotalDuration(clips),
        frameCount: getPaintFrameCount(clips, fps)
    };
}

function addPaintAnimationToSequence() {
    if (!PaintBoard.phaseImage) {
        showNotification('请先生成全息图', 'warning');
        return;
    }
    const animation = createPaintAnimationSnapshot();
    const durationSeconds = (animation.durationMs / 1000).toFixed(1);
    AppState.sequenceList.push({
        id: Date.now(),
        image: PaintBoard.phaseData,
        patternType: 'paint-board',
        filename: PaintBoard.phaseFilename,
        params: `${animation.clips.length} 个片段 · ${durationSeconds} s`,
        paintAnimation: animation
    });
    updateSequenceList();
    showNotification(`动画已加入序列，共 ${animation.frameCount} 帧`, 'success');
}

function renderPaintBoardSequenceFrame(item, frameIndex) {
    const animation = item.paintAnimation;
    const progress = animation.frameCount <= 1 ? 1 : frameIndex / (animation.frameCount - 1);
    const timeMs = animation.durationMs * progress;
    const transform = getPaintTransformAt(timeMs, animation.clips);
    PaintBoard.currentTimeMs = timeMs;
    const targetPreview = document.getElementById('paint_target_preview');
    const phasePreview = document.getElementById('paint_phase_preview');
    drawTransformedImage(animation.source, targetPreview, transform.angle, transform.scale, transform.x, transform.y);
    drawTranslatedPhase(animation.phaseImage, phasePreview, transform.angle, 1 / transform.scale, transform.x, transform.y);
    document.getElementById('paint_timeline').value = String(frameIndex);
    updatePaintFrameLabel(frameIndex);
    return phasePreview.toDataURL('image/png');
}

function sendPaintAnimation() {
    if (!AppState.deviceConnected) {
        showNotification('请先连接SLM设备', 'warning');
        return;
    }
    if (!PaintBoard.phaseImage) {
        generatePaintHologram().then(success => {
            if (success) sendPaintAnimation();
        });
        return;
    }
    if (AppState.playInterval) stopSequence();
    const animation = createPaintAnimationSnapshot();
    const sequenceStart = AppState.sequenceList.reduce((total, item) => total + (item.paintAnimation?.frameCount || 1), 0);
    AppState.sequenceList.push({
        id: Date.now(),
        image: PaintBoard.phaseData,
        patternType: 'paint-board',
        filename: PaintBoard.phaseFilename,
        params: `${animation.clips.length} 个片段 · ${(animation.durationMs / 1000).toFixed(1)} s`,
        paintAnimation: animation
    });
    updateSequenceList();
    AppState.currentImageData = { image: PaintBoard.phaseData, filename: PaintBoard.phaseFilename };
    showOnSLM();
    AppState.sequenceIndex = sequenceStart;
    document.getElementById('play_interval').value = String(Math.max(100, Math.round(1000 / animation.fps)));
    document.getElementById('sequence-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    playSequence();
}

function savePaintJob() {
    const job = {
        format: 'slmjomo-paint-job',
        version: 1,
        input: {
            width: PaintBoard.canvas.width,
            height: PaintBoard.canvas.height,
            strokes: PaintBoard.strokes
        },
        animation: {
            clips: PaintBoard.clips,
            fps: getPaintFps(),
            loop: document.getElementById('paint_loop').checked
        },
        output: {
            phase_image: PaintBoard.phaseData,
            filename: PaintBoard.phaseFilename
        }
    };
    const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `paint_job_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotification('动画任务文件已保存', 'success');
}

async function loadPaintJobFromFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
        showNotification('任务文件不能超过 8 MB', 'warning');
        return;
    }
    try {
        const job = JSON.parse(await file.text());
        if (job.format !== 'slmjomo-paint-job' || job.version !== 1 || !Array.isArray(job.input?.strokes) || !Array.isArray(job.animation?.clips)) {
            throw new Error('任务文件格式不受支持');
        }
        const strokes = sanitizePaintStrokes(job.input.strokes);
        const clips = sanitizePaintClips(job.animation.clips);
        const fps = Math.max(1, Math.min(30, Number(job.animation.fps) || 10));
        const totalDuration = getPaintTotalDuration(clips);
        if (totalDuration > 60000) throw new Error('任务总时长超过 60 秒');
        const phaseData = job.output?.phase_image;
        let phaseImage = null;
        if (typeof phaseData === 'string' && phaseData.length <= 5 * 1024 * 1024 && /^data:image\/(png|bmp);base64,/.test(phaseData)) {
            phaseImage = await loadPaintImage(phaseData);
        }
        stopPaintPreview();
        PaintBoard.strokes = strokes;
        PaintBoard.clips = clips;
        document.getElementById('paint_fps').value = String(fps);
        document.getElementById('paint_loop').checked = Boolean(job.animation.loop);
        redrawPaintBoard();
        renderPaintClips();
        updatePaintTimeline();
        invalidatePaintHologram();
        if (phaseImage) {
            PaintBoard.phaseImage = phaseImage;
            PaintBoard.phaseData = phaseData;
            PaintBoard.phaseFilename = typeof job.output.filename === 'string' ? job.output.filename : null;
            document.getElementById('paint_phase_status').textContent = '已从任务载入相位图';
            document.getElementById('paint_queue_btn').disabled = false;
            document.getElementById('paint_send_btn').disabled = false;
        }
        renderPaintBoardFrame(0);
        showNotification('动画任务已载入', 'success');
    } catch (error) {
        showNotification(`载入任务失败：${error.message}`, 'error');
    }
}

function sanitizePaintStrokes(strokes) {
    if (strokes.length > 1000) throw new Error('笔画数量超过限制');
    let remainingPoints = 20000;
    return strokes.map(stroke => {
        if (!Array.isArray(stroke.points) || !stroke.points.length) throw new Error('笔画数据无效');
        if (stroke.points.length > remainingPoints) throw new Error('轨迹点数量超过限制');
        const points = stroke.points.map(point => ({
            x: Math.max(0, Math.min(512, Number(point.x) || 0)),
            y: Math.max(0, Math.min(512, Number(point.y) || 0))
        }));
        remainingPoints -= points.length;
        return {
            mode: stroke.mode === 'eraser' ? 'eraser' : 'brush',
            size: Math.max(1, Math.min(32, Number(stroke.size) || 8)),
            points
        };
    });
}

function sanitizePaintClips(clips) {
    if (clips.length > 100) throw new Error('动画片段数量超过限制');
    return clips.map(clip => {
        const durationMs = Number(clip.durationMs);
        if (!['rotate', 'scale', 'move'].includes(clip.type) || !Number.isFinite(durationMs) || durationMs < 100 || durationMs > 10000) {
            throw new Error('动画片段参数无效');
        }
        const value = clip.type === 'move'
            ? { x: Number(clip.value?.x), y: Number(clip.value?.y) }
            : Number(clip.value);
        if (clip.type === 'move') {
            if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || Math.abs(value.x) > 256 || Math.abs(value.y) > 256) {
                throw new Error('平移距离超过限制');
            }
        } else if (!Number.isFinite(value)) {
            throw new Error('动画片段参数无效');
        }
        if (clip.type === 'rotate' && Math.abs(value) > 360) throw new Error('旋转角度超过限制');
        if (clip.type === 'scale' && (value < 0.25 || value > 4)) throw new Error('缩放倍率超过限制');
        return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: clip.type,
            value,
            durationMs
        };
    });
}
