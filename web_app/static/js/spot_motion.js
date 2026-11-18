(function() {
    'use strict';

    const COLORS = ['#d14d41', '#167d6b', '#2468a0'];
    const MAX_MARKERS = 200;
    const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
    const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

    const state = {
        initialized: false,
        image: null,
        imageDataUrl: null,
        imageDrawRect: null,
        roi: null,
        roiMode: false,
        roiDragStart: null,
        roiDragCurrent: null,
        scaleMode: false,
        scalePoints: [],
        mediaStream: null,
        mediaFrameRequest: 0,
        mediaSourceName: null,
        liveImageCaptured: false,
        suppressMicroscopeClick: false,
        markers: [],
        selectedMarkerId: null,
        origin: null,
        originMode: false,
        activeSpot: 0,
        assignments: [null, null, null],
        paths: [[], [], []],
        jobId: null,
        jobCalibration: null,
        jobFrames: [],
        phaseUrls: [],
        reconstructionUrls: [],
        previewIndex: 0,
        feedbackMode: false,
        feedbackMeasurements: [null, null, null],
        feedbackOffsets: [{ x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }],
        cursorImagePx: null,
        cursorFocusUm: { x_um: 0, y_um: 0 },
        generating: false,
        addingToCgh: false,
        uploading: false,
        exporting: false
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function imageWidth() {
        return state.image?.videoWidth || state.image?.naturalWidth || state.image?.width || 0;
    }

    function imageHeight() {
        return state.image?.videoHeight || state.image?.naturalHeight || state.image?.height || 0;
    }

    function numberValue(id, fallback) {
        const input = byId(id);
        const value = input ? Number(input.value) : fallback;
        return Number.isFinite(value) ? value : fallback;
    }

    function notify(message, kind) {
        if (typeof window.showNotification === 'function') {
            window.showNotification(message, kind || 'info');
            return;
        }
        setStatus(message, kind || 'info');
    }

    function setStatus(message, kind) {
        const output = byId('motion_status');
        if (!output) return;
        output.textContent = message;
        output.dataset.state = kind || 'info';
    }

    function setProgress(value, label) {
        const progress = byId('motion_progress');
        if (progress) {
            progress.max = 100;
            progress.value = Math.max(0, Math.min(100, Number(value) || 0));
            progress.setAttribute('aria-label', label || '相位帧生成进度');
        }
        if (label) {
            const output = byId('motion_status');
            if (output) output.textContent = label;
        }
    }

    function activeInputsDisabled(disabled) {
        ['motion_generate_btn', 'motion_image_input', 'motion_origin_button', 'motion_assign_select',
            'motion_focus_canvas'].forEach(id => {
            const element = byId(id);
            if (element) element.disabled = !!disabled;
        });
        const tabs = byId('motion_spot_tabs');
        if (tabs) tabs.querySelectorAll('button').forEach(button => { button.disabled = !!disabled; });
        const generate = byId('motion_generate_btn');
        if (generate) generate.disabled = !!disabled;
    }

    function assignControlsEnabled(enabled) {
        ['motion_add_cgh_btn', 'motion_export_btn', 'motion_upload_btn',
            'motion_preview_prev', 'motion_preview_next', 'motion_feedback_mode_btn'].forEach(id => {
            const element = byId(id);
            if (element) element.disabled = !enabled;
        });
        updateFeedbackButtons();
    }

    function updateFeedbackButtons() {
        const mode = byId('motion_feedback_mode_btn');
        const apply = byId('motion_apply_feedback_btn');
        const clear = byId('motion_clear_feedback_btn');
        const ready = state.feedbackMeasurements.every(item =>
            item && item.frame_index === state.previewIndex);
        if (mode) mode.disabled = !state.jobId || !state.jobFrames.length ||
            !state.image || !state.origin || !jobCalibrationMatchesCurrent();
        if (apply) apply.disabled = !state.feedbackMode || !ready;
        if (clear) clear.disabled = state.feedbackOffsets.every(offset =>
            Math.abs(offset.x_um) < 1e-12 && Math.abs(offset.y_um) < 1e-12);
    }

    function currentFeedbackCalibration() {
        if (!state.origin) return null;
        return {
            origin_x_px: Number(state.origin.x_px),
            origin_y_px: Number(state.origin.y_px),
            pixels_per_um: numberValue('motion_pixels_per_um', NaN),
            focus_scale_x: numberValue('motion_focus_scale_x', 1),
            focus_scale_y: numberValue('motion_focus_scale_y', 1)
        };
    }

    function jobCalibrationMatchesCurrent() {
        const current = currentFeedbackCalibration();
        if (!current || !state.jobCalibration) return false;
        return Object.keys(current).every(key => Number.isFinite(current[key]) &&
            Math.abs(current[key] - state.jobCalibration[key]) <= 1e-9);
    }

    function setFeedbackReport(message, stateName) {
        const report = byId('motion_feedback_report');
        if (!report) return;
        report.textContent = message;
        report.dataset.state = stateName || 'info';
    }

    function resetFeedbackForCalibrationChange() {
        state.feedbackOffsets = [{ x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }];
        state.feedbackMeasurements = [null, null, null];
        state.feedbackMode = false;
        const button = byId('motion_feedback_mode_btn');
        if (button) {
            button.classList.remove('is-active');
            button.setAttribute('aria-pressed', 'false');
        }
        setFeedbackReport('坐标标定已更改，请重新生成相位帧后再做反馈测量。', 'info');
        updateFeedbackButtons();
    }

    function finitePoint(point) {
        return point && Number.isFinite(Number(point.x_um)) && Number.isFinite(Number(point.y_um));
    }

    function scaleCalibration() {
        const scale = numberValue('motion_pixels_per_um', NaN);
        const reciprocal = byId('motion_um_per_px');
        if (reciprocal) {
            reciprocal.value = Number.isFinite(scale) && scale > 0
                ? (1 / scale).toPrecision(6)
                : '';
        }
        drawMicroscope();
        renderMarkers();
    }

    function sourcePointFromCanvas(canvas, event) {
        if (!state.image || !state.imageDrawRect) return null;
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return null;
        const canvasX = (event.clientX - bounds.left) * canvas.width / bounds.width;
        const canvasY = (event.clientY - bounds.top) * canvas.height / bounds.height;
        const rect = state.imageDrawRect;
        if (canvasX < rect.x || canvasY < rect.y ||
                canvasX > rect.x + rect.width || canvasY > rect.y + rect.height) {
            return null;
        }
        const roi = state.roi || { x: 0, y: 0, width: imageWidth(), height: imageHeight() };
        return {
            x_px: Math.max(0, Math.min(roi.width,
                (canvasX - rect.x) / rect.scale)),
            y_px: Math.max(0, Math.min(roi.height,
                (canvasY - rect.y) / rect.scale))
        };
    }

    function microscopeCanvasPointFromSource(point) {
        const rect = state.imageDrawRect;
        if (!rect) return null;
        return { x: rect.x + point.x_px * rect.scale, y: rect.y + point.y_px * rect.scale };
    }

    function sampleToFocusUm(xPx, yPx) {
        if (!state.origin) return null;
        const pxPerUm = numberValue('motion_pixels_per_um', NaN);
        if (!(pxPerUm > 0) || !Number.isFinite(pxPerUm)) return null;
        const xScale = numberValue('motion_focus_scale_x', 1);
        const yScale = numberValue('motion_focus_scale_y', 1);
        return {
            x_um: ((xPx - state.origin.x_px) / pxPerUm) * xScale,
            y_um: ((state.origin.y_px - yPx) / pxPerUm) * yScale
        };
    }

    function drawMicroscope() {
        const canvas = byId('motion_microscope_canvas');
        if (!canvas) return;
        canvas.classList?.toggle('roi-selecting', state.roiMode);
        canvas.classList?.toggle('calibration-selecting', state.scaleMode);
        const context = canvas.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#101820';
        context.fillRect(0, 0, canvas.width, canvas.height);
        state.imageDrawRect = null;

        if (state.image) {
            const roi = state.roi || { x: 0, y: 0, width: imageWidth(), height: imageHeight() };
            const scale = Math.min(canvas.width / roi.width,
                canvas.height / roi.height);
            const width = roi.width * scale;
            const height = roi.height * scale;
            const x = (canvas.width - width) / 2;
            const y = (canvas.height - height) / 2;
            state.imageDrawRect = { x, y, width, height, scale };
            context.drawImage(state.image, roi.x, roi.y, roi.width, roi.height, x, y, width, height);
        } else {
            context.fillStyle = '#d2d9de';
            context.font = '16px Segoe UI, Microsoft YaHei, sans-serif';
            context.textAlign = 'center';
            context.fillText('导入显微镜图像后点击标记材料', canvas.width / 2, canvas.height / 2);
        }

        state.markers.forEach((marker, index) => {
            const point = microscopeCanvasPointFromSource(marker);
            if (!point) return;
            const isSelected = marker.id === state.selectedMarkerId;
            context.beginPath();
            context.arc(point.x, point.y, isSelected ? 8 : 6, 0, Math.PI * 2);
            context.fillStyle = COLORS[index % COLORS.length];
            context.fill();
            context.lineWidth = isSelected ? 3 : 1.5;
            context.strokeStyle = '#fff';
            context.stroke();
            context.font = 'bold 13px Segoe UI, sans-serif';
            context.textAlign = 'left';
            context.fillStyle = '#fff';
            context.fillText(marker.name, point.x + 9, point.y - 7);
        });

        state.feedbackMeasurements.forEach((measurement, index) => {
            if (!measurement) return;
            const point = microscopeCanvasPointFromSource(measurement);
            if (!point) return;
            context.beginPath();
            context.arc(point.x, point.y, 9, 0, Math.PI * 2);
            context.lineWidth = 2;
            context.strokeStyle = COLORS[index];
            context.stroke();
            context.fillStyle = '#fff';
            context.font = 'bold 12px Segoe UI, sans-serif';
            context.textAlign = 'center';
            context.fillText(String(index + 1), point.x, point.y + 4);
        });

        if (state.origin) {
            const point = microscopeCanvasPointFromSource(state.origin);
            if (point) {
                context.strokeStyle = '#f5d547';
                context.lineWidth = 2;
                context.beginPath();
                context.moveTo(point.x - 9, point.y);
                context.lineTo(point.x + 9, point.y);
                context.moveTo(point.x, point.y - 9);
                context.lineTo(point.x, point.y + 9);
                context.stroke();
                context.fillStyle = '#f5d547';
                context.font = '12px Segoe UI, sans-serif';
                context.fillText('O', point.x + 8, point.y - 8);
            }
        }

        if (state.cursorImagePx) {
            const point = microscopeCanvasPointFromSource(state.cursorImagePx);
            if (point) {
                context.strokeStyle = '#fff';
                context.setLineDash([3, 3]);
                context.beginPath();
                context.arc(point.x, point.y, 11, 0, Math.PI * 2);
                context.stroke();
                context.setLineDash([]);
            }
        }

        if (state.scalePoints.length) {
            const first = microscopeCanvasPointFromSource(state.scalePoints[0]);
            if (first) {
                context.fillStyle = '#f5d547';
                context.strokeStyle = '#111a20';
                context.lineWidth = 2;
                context.beginPath();
                context.arc(first.x, first.y, 6, 0, Math.PI * 2);
                context.fill();
                context.stroke();
                if (state.scalePoints[1]) {
                    const second = microscopeCanvasPointFromSource(state.scalePoints[1]);
                    context.beginPath();
                    context.moveTo(first.x, first.y);
                    context.lineTo(second.x, second.y);
                    context.stroke();
                }
            }
        }

        if (state.roiMode && state.roiDragStart && state.roiDragCurrent) {
            const rect = state.imageDrawRect;
            const left = Math.min(state.roiDragStart.x, state.roiDragCurrent.x);
            const top = Math.min(state.roiDragStart.y, state.roiDragCurrent.y);
            const width = Math.abs(state.roiDragCurrent.x - state.roiDragStart.x);
            const height = Math.abs(state.roiDragCurrent.y - state.roiDragStart.y);
            context.fillStyle = 'rgba(8, 127, 140, 0.18)';
            context.strokeStyle = '#fff';
            context.lineWidth = 2;
            context.fillRect(rect.x + left * rect.scale, rect.y + top * rect.scale,
                width * rect.scale, height * rect.scale);
            context.strokeRect(rect.x + left * rect.scale, rect.y + top * rect.scale,
                width * rect.scale, height * rect.scale);
        }
    }

    function drawFocusPlot() {
        const canvas = byId('motion_focus_canvas');
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        const width = canvas.width;
        const height = canvas.height;
        const field = Math.max(1, numberValue('motion_focus_field_um', 20));
        const pad = 34;
        const plotW = width - pad * 2;
        const plotH = height - pad * 2;
        const toCanvas = point => ({
            x: pad + (point.x_um + field) / (field * 2) * plotW,
            y: pad + (field - point.y_um) / (field * 2) * plotH
        });

        context.clearRect(0, 0, width, height);
        context.fillStyle = '#f4f6f7';
        context.fillRect(0, 0, width, height);
        context.strokeStyle = '#d4dade';
        context.lineWidth = 1;
        for (let i = 0; i <= 8; i++) {
            const x = pad + plotW * i / 8;
            const y = pad + plotH * i / 8;
            context.beginPath();
            context.moveTo(x, pad);
            context.lineTo(x, pad + plotH);
            context.moveTo(pad, y);
            context.lineTo(pad + plotW, y);
            context.stroke();
        }
        context.strokeStyle = '#56636d';
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(pad, pad + plotH / 2);
        context.lineTo(pad + plotW, pad + plotH / 2);
        context.moveTo(pad + plotW / 2, pad);
        context.lineTo(pad + plotW / 2, pad + plotH);
        context.stroke();
        context.fillStyle = '#44515b';
        context.font = '12px Segoe UI, sans-serif';
        context.textAlign = 'left';
        context.fillText(`−${field} μm`, pad, height - 8);
        context.textAlign = 'right';
        context.fillText(`+${field} μm`, width - pad, height - 8);
        context.textAlign = 'left';
        context.fillText(`+${field} μm`, 4, pad + 4);
        context.fillText(`−${field} μm`, 4, pad + plotH);

        state.paths.forEach((path, index) => {
            const color = COLORS[index];
            if (path.length) {
                const offset = state.feedbackOffsets[index];
                const correctedPath = path.map(point => ({
                    x_um: point.x_um + offset.x_um,
                    y_um: point.y_um + offset.y_um
                }));
                context.strokeStyle = color;
                context.lineWidth = index === state.activeSpot ? 3 : 2;
                context.beginPath();
                correctedPath.forEach((point, pointIndex) => {
                    const position = toCanvas(point);
                    if (pointIndex === 0) context.moveTo(position.x, position.y);
                    else context.lineTo(position.x, position.y);
                });
                context.stroke();
                correctedPath.forEach((point, pointIndex) => {
                    const position = toCanvas(point);
                    context.beginPath();
                    context.arc(position.x, position.y, pointIndex === 0 ? 7 : 4, 0, Math.PI * 2);
                    context.fillStyle = color;
                    context.fill();
                    if (pointIndex === 0) {
                        context.lineWidth = 2;
                        context.strokeStyle = '#fff';
                        context.stroke();
                    }
                });
            }
        });

        const cursor = toCanvas(state.cursorFocusUm);
        context.strokeStyle = COLORS[state.activeSpot];
        context.lineWidth = 2;
        context.beginPath();
        context.arc(cursor.x, cursor.y, 8, 0, Math.PI * 2);
        context.stroke();
    }

    function renderMarkers() {
        const list = byId('motion_marker_list');
        const select = byId('motion_assign_select');
        if (!list) return;

        const priorValue = state.selectedMarkerId || '';
        list.replaceChildren();
        if (select) {
            select.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '选择要分配的材料';
            select.append(placeholder);
        }

        if (!state.markers.length) {
            const empty = document.createElement('p');
            empty.className = 'motion-empty-state';
            empty.textContent = '尚未标记材料';
            list.append(empty);
        }

        state.markers.forEach((marker, index) => {
            const row = document.createElement('div');
            row.className = 'motion-marker-row' +
                (marker.id === state.selectedMarkerId ? ' is-selected' : '');
            const choose = document.createElement('button');
            choose.type = 'button';
            choose.className = 'motion-marker-select';
            choose.textContent = marker.name;
            choose.setAttribute('aria-pressed', String(marker.id === state.selectedMarkerId));
            choose.addEventListener('click', () => selectMarker(marker.id));
            const coordinates = document.createElement('span');
            const calibrated = sampleToFocusUm(marker.x_px, marker.y_px);
            coordinates.textContent = calibrated
                ? `${calibrated.x_um.toFixed(2)}, ${calibrated.y_um.toFixed(2)} μm`
                : `${marker.x_px.toFixed(0)}, ${marker.y_px.toFixed(0)} px`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'motion-marker-remove';
            remove.textContent = '×';
            remove.title = `删除 ${marker.name}`;
            remove.setAttribute('aria-label', `删除 ${marker.name}`);
            remove.addEventListener('click', () => removeMarker(marker.id));
            row.append(choose, coordinates, remove);
            list.append(row);

            if (select) {
                const option = document.createElement('option');
                option.value = marker.id;
                option.textContent = marker.name;
                select.append(option);
            }
        });
        if (select && state.markers.some(marker => marker.id === priorValue)) {
            select.value = priorValue;
        }
        drawMicroscope();
    }

    function selectMarker(markerId) {
        state.selectedMarkerId = markerId;
        const select = byId('motion_assign_select');
        if (select) select.value = markerId;
        renderMarkers();
    }

    function removeMarker(markerId) {
        state.markers = state.markers.filter(marker => marker.id !== markerId);
        if (state.selectedMarkerId === markerId) state.selectedMarkerId = null;
        state.assignments.forEach((value, index) => {
            if (value === markerId) {
                state.assignments[index] = null;
                state.paths[index] = [];
            }
        });
        renderMarkers();
        drawFocusPlot();
    }

    function assignSelectedMaterial(spotIndex) {
        const marker = state.markers.find(item => item.id === state.selectedMarkerId);
        if (!marker) return;
        const initial = sampleToFocusUm(marker.x_px, marker.y_px);
        if (!initial) {
            notify('请先设置标定原点并输入有效的 px/μm 比例', 'warning');
            return;
        }
        state.assignments[spotIndex] = marker.id;
        const previous = state.paths[spotIndex];
        state.paths[spotIndex] = previous.length
            ? [{ x_um: initial.x_um, y_um: initial.y_um }, ...previous.slice(1)]
            : [{ x_um: initial.x_um, y_um: initial.y_um }];
        state.activeSpot = spotIndex;
        syncSpotTabs();
        drawFocusPlot();
        setStatus(`${marker.name} 已分配给光斑 ${spotIndex + 1}`, 'success');
    }

    function syncSpotTabs() {
        const container = byId('motion_spot_tabs');
        if (!container) return;
        container.querySelectorAll('[data-spot-index]').forEach(button => {
            const index = Number(button.dataset.spotIndex);
            const active = index === state.activeSpot;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
            const marker = state.markers.find(item => item.id === state.assignments[index]);
            button.title = marker ? `光斑 ${index + 1} · ${marker.name}` : `光斑 ${index + 1}`;
        });
    }

    function addMaterialAt(point) {
        if (state.markers.length >= MAX_MARKERS) {
            notify(`最多标记 ${MAX_MARKERS} 个材料位置`, 'warning');
            return;
        }
        const marker = {
            id: `material-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            name: `材料 ${state.markers.length + 1}`,
            x_px: point.x_px,
            y_px: point.y_px
        };
        state.markers.push(marker);
        state.selectedMarkerId = marker.id;
        renderMarkers();
        const select = byId('motion_assign_select');
        if (select) select.value = marker.id;
        setStatus(`${marker.name} 已标记`, 'success');
    }

    function beginSpotFeedback() {
        if (!state.image || !state.origin ||
                !(numberValue('motion_pixels_per_um', NaN) > 0)) {
            notify('请先准备显微镜画面、标定原点和 px/μm 比例', 'warning');
            return false;
        }
        if (!state.jobId || !Array.isArray(state.jobFrames) || !state.jobFrames.length) {
            notify('请先生成一版路径相位帧，再进行位置反馈校准', 'warning');
            return false;
        }
        if (!jobCalibrationMatchesCurrent()) {
            notify('当前坐标标定与这组相位帧不一致，请先重新生成路径相位帧', 'warning');
            return false;
        }
        if (state.mediaStream) stopLiveMicroscope();
        state.roiMode = false;
        state.scaleMode = false;
        state.originMode = false;
        ['motion_roi_button', 'motion_scale_button', 'motion_origin_button'].forEach(id => {
            const modeButton = byId(id);
            if (modeButton) {
                modeButton.classList.remove('is-active');
                modeButton.setAttribute('aria-pressed', 'false');
            }
        });
        state.feedbackMode = true;
        state.feedbackMeasurements = [null, null, null];
        const button = byId('motion_feedback_mode_btn');
        if (button) {
            button.classList.add('is-active');
            button.setAttribute('aria-pressed', 'true');
        }
        setFeedbackReport(
            `已冻结画面。选择右侧光斑 ${state.activeSpot + 1}，在左侧点选对应亮斑附近；完成三个光斑后应用补偿。`,
            'info'
        );
        setStatus(`正在校准第 ${state.previewIndex + 1} 帧的光斑位置`, 'info');
        updateFeedbackButtons();
        drawMicroscope();
        return true;
    }

    function recordSpotMeasurement(spotIndex, measuredPoint, quality = {}) {
        if (!Number.isInteger(spotIndex) || spotIndex < 0 || spotIndex >= 3) {
            throw new Error('光斑编号无效');
        }
        const frame = state.jobFrames[state.previewIndex];
        const target = frame && Array.isArray(frame.spots) && frame.spots[spotIndex];
        if (!target || !finitePoint(target) || !measuredPoint ||
                !Number.isFinite(Number(measuredPoint.x_px)) ||
                !Number.isFinite(Number(measuredPoint.y_px))) {
            throw new Error('当前帧缺少可用的目标或实测光斑位置');
        }
        const measured = sampleToFocusUm(Number(measuredPoint.x_px), Number(measuredPoint.y_px));
        if (!measured) throw new Error('像素标定无效，无法换算实测光斑位置');
        const measurement = {
            x_px: Number(measuredPoint.x_px),
            y_px: Number(measuredPoint.y_px),
            frame_index: state.previewIndex,
            error_x_um: measured.x_um - Number(target.x_um),
            error_y_um: measured.y_um - Number(target.y_um),
            confidence: Number.isFinite(Number(quality.confidence)) ? Number(quality.confidence) : null,
            area_px: Number.isFinite(Number(quality.area_px)) ? Number(quality.area_px) : null
        };
        state.feedbackMeasurements[spotIndex] = measurement;
        const lines = state.feedbackMeasurements.map((item, index) => item
            ? `光斑 ${index + 1}：偏差 (${item.error_x_um.toFixed(3)}, ${item.error_y_um.toFixed(3)}) μm`
            : `光斑 ${index + 1}：待测量`);
        setFeedbackReport(lines.join('\n'), 'info');
        updateFeedbackButtons();
        drawMicroscope();
        return { ...measurement };
    }

    function measureSpotAt(point) {
        const vision = window.SpotVision;
        if (!vision || typeof vision.estimateBrightSpot !== 'function') {
            throw new Error('光斑检测模块尚未加载');
        }
        const radius = numberValue('motion_detection_radius_px', 16);
        if (!Number.isInteger(radius) || radius < 3 || radius > 128) {
            throw new Error('局部搜索半径须为 3–128 px');
        }
        const roi = state.roi || { x: 0, y: 0, width: imageWidth(), height: imageHeight() };
        const sourceX = roi.x + point.x_px;
        const sourceY = roi.y + point.y_px;
        const sourceLeft = Math.floor(sourceX) - radius;
        const sourceTop = Math.floor(sourceY) - radius;
        const patchSize = radius * 2 + 1;
        if (sourceLeft < 0 || sourceTop < 0 || sourceLeft + patchSize > imageWidth() ||
                sourceTop + patchSize > imageHeight()) {
            throw new Error('点选位置太靠近图像边缘，请移到光斑附近重新点选');
        }
        const patch = document.createElement('canvas');
        patch.width = patchSize;
        patch.height = patchSize;
        const context = patch.getContext('2d', { willReadFrequently: true });
        context.drawImage(state.image, sourceLeft, sourceTop, patchSize, patchSize,
            0, 0, patchSize, patchSize);
        const imageData = context.getImageData(0, 0, patchSize, patchSize);
        const detected = vision.estimateBrightSpot(
            imageData, sourceX - sourceLeft, sourceY - sourceTop, radius
        );
        const sourcePoint = {
            x_px: sourceLeft + detected.x_px - roi.x,
            y_px: sourceTop + detected.y_px - roi.y
        };
        return recordSpotMeasurement(state.activeSpot, sourcePoint, detected);
    }

    function applySpotFeedback() {
        if (!state.feedbackMeasurements.every(item =>
            item && item.frame_index === state.previewIndex)) {
            throw new Error('请在同一帧中完成三个光斑的测量');
        }
        const gain = numberValue('motion_feedback_gain', 0.75);
        if (!Number.isFinite(gain) || gain < 0.1 || gain > 1) {
            throw new Error('补偿增益须在 0.1–1 之间');
        }
        state.feedbackMeasurements.forEach((measurement, index) => {
            state.feedbackOffsets[index].x_um -= measurement.error_x_um * gain;
            state.feedbackOffsets[index].y_um -= measurement.error_y_um * gain;
        });
        state.feedbackMode = false;
        const button = byId('motion_feedback_mode_btn');
        if (button) {
            button.classList.remove('is-active');
            button.setAttribute('aria-pressed', 'false');
        }
        const lines = state.feedbackOffsets.map((offset, index) =>
            `光斑 ${index + 1} 累积补偿：(${offset.x_um.toFixed(3)}, ${offset.y_um.toFixed(3)}) μm`);
        setFeedbackReport(lines.join('\n'), 'success');
        setStatus('位置补偿已应用；重新生成相位帧以计算修正后的路径', 'success');
        drawFocusPlot();
        updateFeedbackButtons();
        return state.feedbackOffsets.map(offset => ({ ...offset }));
    }

    function clearSpotFeedback() {
        state.feedbackOffsets = [{ x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }];
        state.feedbackMeasurements = [null, null, null];
        state.feedbackMode = false;
        const button = byId('motion_feedback_mode_btn');
        if (button) {
            button.classList.remove('is-active');
            button.setAttribute('aria-pressed', 'false');
        }
        setFeedbackReport('位置补偿已清除', 'info');
        drawFocusPlot();
        drawMicroscope();
        updateFeedbackButtons();
    }

    function clickMicroscope(event) {
        const canvas = byId('motion_microscope_canvas');
        const point = canvas && sourcePointFromCanvas(canvas, event);
        if (!point) return;
        if (state.suppressMicroscopeClick) {
            state.suppressMicroscopeClick = false;
            return;
        }
        if (state.feedbackMode) {
            try {
                const measurement = measureSpotAt(point);
                setStatus(`光斑 ${state.activeSpot + 1} 已检测：偏差 ` +
                    `(${measurement.error_x_um.toFixed(3)}, ${measurement.error_y_um.toFixed(3)}) μm`, 'success');
            } catch (error) {
                setFeedbackReport(error.message, 'error');
                setStatus(`光斑检测失败：${error.message}`, 'warning');
            }
            return;
        }
        if (state.roiMode) return;
        if (state.scaleMode) {
            state.scalePoints.push(point);
            if (state.scalePoints.length === 1) {
                setStatus('已记录第一个标尺端点，请点击第二个端点', 'info');
            } else {
                const distancePx = Math.hypot(
                    state.scalePoints[1].x_px - state.scalePoints[0].x_px,
                    state.scalePoints[1].y_px - state.scalePoints[0].y_px
                );
                const referenceUm = numberValue('motion_reference_distance_um', NaN);
                if (!(distancePx >= 1) || !(referenceUm > 0)) {
                    state.scalePoints = [];
                    setStatus('标定失败：端点距离至少 1 px，参考长度必须大于 0 μm', 'error');
                } else {
                    const pxPerUm = distancePx / referenceUm;
                    resetFeedbackForCalibrationChange();
                    const input = byId('motion_pixels_per_um');
                    if (input) input.value = String(Number(pxPerUm.toPrecision(8)));
                    state.scaleMode = false;
                    state.scalePoints = [];
                    const button = byId('motion_scale_button');
                    if (button) {
                        button.classList.remove('is-active');
                        button.setAttribute('aria-pressed', 'false');
                    }
                    const output = byId('motion_scale_status');
                    if (output) output.textContent = `${(1 / pxPerUm).toPrecision(6)} μm/px`;
                    scaleCalibration();
                    setStatus(`两点标定完成：${pxPerUm.toPrecision(6)} px/μm`, 'success');
                }
            }
            drawMicroscope();
            return;
        }
        if (state.originMode) {
            resetFeedbackForCalibrationChange();
            state.origin = point;
            state.originMode = false;
            const button = byId('motion_origin_button');
            if (button) {
                button.classList.remove('is-active');
                button.setAttribute('aria-pressed', 'false');
            }
            setStatus(`标定原点已设为 (${point.x_px.toFixed(1)}, ${point.y_px.toFixed(1)}) px`, 'success');
            renderMarkers();
        } else {
            addMaterialAt(point);
        }
    }

    function canvasImagePoint(canvas, event) {
        if (!state.image || !state.imageDrawRect) return null;
        const bounds = canvas.getBoundingClientRect();
        const px = (event.clientX - bounds.left) * canvas.width / bounds.width;
        const py = (event.clientY - bounds.top) * canvas.height / bounds.height;
        const rect = state.imageDrawRect;
        if (px < rect.x || py < rect.y || px > rect.x + rect.width || py > rect.y + rect.height) return null;
        const roi = state.roi || { x: 0, y: 0, width: imageWidth(), height: imageHeight() };
        return {
            x_px: Math.max(0, Math.min(roi.width, (px - rect.x) / rect.scale)),
            y_px: Math.max(0, Math.min(roi.height, (py - rect.y) / rect.scale))
        };
    }

    function finishRoiSelection(event) {
        const canvas = byId('motion_microscope_canvas');
        if (!state.roiMode || !canvas || !state.roiDragStart) return;
        const end = canvasImagePoint(canvas, event);
        const start = state.roiDragStart;
        state.roiDragStart = null;
        state.roiDragCurrent = null;
        state.roiMode = false;
        const roiButton = byId('motion_roi_button');
        if (roiButton) {
            roiButton.classList.remove('is-active');
            roiButton.setAttribute('aria-pressed', 'false');
        }
        if (!end) {
            setStatus('ROI 选择已取消', 'info');
            drawMicroscope();
            return;
        }
        const left = Math.floor(Math.min(start.x_px, end.x_px));
        const top = Math.floor(Math.min(start.y_px, end.y_px));
        const width = Math.floor(Math.abs(end.x_px - start.x_px));
        const height = Math.floor(Math.abs(end.y_px - start.y_px));
        if (width < 16 || height < 16) {
            setStatus('ROI 区域至少需要 16×16 px', 'warning');
            drawMicroscope();
            return;
        }
        const previous = state.roi || { x: 0, y: 0 };
        state.suppressMicroscopeClick = true;
        state.roi = { x: previous.x + left, y: previous.y + top, width, height };
        state.markers = [];
        state.selectedMarkerId = null;
        state.assignments = [null, null, null];
        state.paths = [[], [], []];
        state.origin = null;
        state.imageDataUrl = null;
        state.jobId = null;
        state.jobCalibration = null;
        state.jobFrames = [];
        state.phaseUrls = [];
        state.reconstructionUrls = [];
        state.previewIndex = 0;
        state.feedbackMode = false;
        state.feedbackMeasurements = [null, null, null];
        state.feedbackOffsets = [{ x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }];
        assignControlsEnabled(false);
        renderMarkers();
        drawMicroscope();
        setStatus(`ROI 已设为 ${width}×${height} px；请重新标记原点和材料`, 'success');
    }

    function stopLiveMicroscope() {
        if (state.mediaFrameRequest) cancelAnimationFrame(state.mediaFrameRequest);
        state.mediaFrameRequest = 0;
        if (state.mediaStream) state.mediaStream.getTracks().forEach(track => track.stop());
        state.mediaStream = null;
        state.mediaSourceName = null;
        const source = state.image;
        if (source && source.tagName === 'VIDEO') {
            const frozen = document.createElement('canvas');
            frozen.width = source.videoWidth;
            frozen.height = source.videoHeight;
            frozen.getContext('2d').drawImage(source, 0, 0);
            source.pause();
            source.srcObject = null;
            state.image = frozen;
            state.imageDataUrl = null;
        }
        drawMicroscope();
        updateLiveButtons();
    }

    function updateLiveButtons() {
        const live = !!state.mediaStream;
        const stop = byId('motion_camera_stop_btn');
        if (stop) stop.disabled = !live;
        ['motion_camera_start_btn', 'motion_screen_start_btn'].forEach(id => {
            const button = byId(id);
            if (button) button.disabled = live;
        });
    }

    async function startLiveMicroscope(kind) {
        if (!navigator.mediaDevices) {
            notify('当前浏览器不支持实时媒体采集；请使用 HTTPS 或 localhost', 'error');
            return;
        }
        stopLiveMicroscope();
        try {
            const stream = kind === 'screen'
                ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false })
                : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
            const video = document.createElement('video');
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.srcObject = stream;
            await video.play();
            await new Promise(resolve => {
                if (video.videoWidth && video.videoHeight) resolve();
                else video.addEventListener('loadedmetadata', resolve, { once: true });
            });
            state.mediaStream = stream;
            state.mediaSourceName = kind;
            state.image = video;
            state.imageDataUrl = null;
            state.liveImageCaptured = true;
            state.roi = null;
            state.markers = [];
            state.origin = null;
            state.assignments = [null, null, null];
            state.paths = [[], [], []];
            stream.getVideoTracks()[0]?.addEventListener('ended', stopLiveMicroscope, { once: true });
            const renderFrame = () => {
                if (!state.mediaStream || state.image !== video) return;
                drawMicroscope();
                state.mediaFrameRequest = requestAnimationFrame(renderFrame);
            };
            updateLiveButtons();
            renderFrame();
            setStatus(`${kind === 'screen' ? '屏幕共享' : '摄像头'}实时画面已连接：${video.videoWidth}×${video.videoHeight} px`, 'success');
        } catch (error) {
            setStatus(`无法启动实时画面：${error.message}`, 'error');
            notify(`无法启动实时画面：${error.message}`, 'error');
            updateLiveButtons();
        }
    }

    function focusPointFromCanvas(event) {
        const canvas = byId('motion_focus_canvas');
        if (!canvas) return null;
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return null;
        const pixelX = (event.clientX - bounds.left) * canvas.width / bounds.width;
        const pixelY = (event.clientY - bounds.top) * canvas.height / bounds.height;
        const field = Math.max(1, numberValue('motion_focus_field_um', 20));
        const pad = 34;
        const width = canvas.width - pad * 2;
        const height = canvas.height - pad * 2;
        if (pixelX < pad || pixelY < pad || pixelX > canvas.width - pad || pixelY > canvas.height - pad) {
            return null;
        }
        return {
            x_um: ((pixelX - pad) / width * 2 - 1) * field,
            y_um: (1 - (pixelY - pad) / height * 2) * field
        };
    }

    function clickFocusPlot(event) {
        const point = focusPointFromCanvas(event);
        if (!point) return;
        state.cursorFocusUm = point;
        state.paths[state.activeSpot].push(point);
        drawFocusPlot();
        setStatus(`光斑 ${state.activeSpot + 1} 路径点 ${state.paths[state.activeSpot].length}: ` +
            `(${point.x_um.toFixed(2)}, ${point.y_um.toFixed(2)}) μm`, 'info');
    }

    function undoWaypoint() {
        const path = state.paths[state.activeSpot];
        if (!path.length) return;
        path.pop();
        drawFocusPlot();
        setStatus(`已撤销光斑 ${state.activeSpot + 1} 的最后一个路径点`, 'info');
    }

    function clearActivePath() {
        const markerId = state.assignments[state.activeSpot];
        const marker = state.markers.find(item => item.id === markerId);
        const start = marker ? sampleToFocusUm(marker.x_px, marker.y_px) : null;
        state.paths[state.activeSpot] = start ? [start] : [];
        drawFocusPlot();
        setStatus(start
            ? `已清除光斑 ${state.activeSpot + 1} 的移动路径，保留材料起点`
            : `已清除光斑 ${state.activeSpot + 1} 的路径`, 'info');
    }

    function keyboardCanvasAction(canvas, event, kind) {
        const direction = event.key;
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Backspace', 'Delete'].includes(direction)) return;
        event.preventDefault();
        if (kind === 'microscope') {
            if (!state.image) return;
            if (!state.cursorImagePx) {
                const roi = state.roi || { width: imageWidth(), height: imageHeight() };
                state.cursorImagePx = { x_px: roi.width / 2, y_px: roi.height / 2 };
            }
            const step = event.shiftKey ? 10 : 1;
            if (direction === 'ArrowLeft') state.cursorImagePx.x_px -= step;
            if (direction === 'ArrowRight') state.cursorImagePx.x_px += step;
            if (direction === 'ArrowUp') state.cursorImagePx.y_px -= step;
            if (direction === 'ArrowDown') state.cursorImagePx.y_px += step;
            const roi = state.roi || { width: imageWidth(), height: imageHeight() };
            state.cursorImagePx.x_px = Math.max(0, Math.min(roi.width, state.cursorImagePx.x_px));
            state.cursorImagePx.y_px = Math.max(0, Math.min(roi.height, state.cursorImagePx.y_px));
            if (direction === 'Enter' || direction === ' ') clickMicroscope({
                clientX: canvas.getBoundingClientRect().left +
                    (state.imageDrawRect.x + state.cursorImagePx.x_px * state.imageDrawRect.scale) /
                    canvas.width * canvas.getBoundingClientRect().width,
                clientY: canvas.getBoundingClientRect().top +
                    (state.imageDrawRect.y + state.cursorImagePx.y_px * state.imageDrawRect.scale) /
                    canvas.height * canvas.getBoundingClientRect().height
            });
            drawMicroscope();
            return;
        }

        if (direction === 'Backspace' || direction === 'Delete') {
            event.preventDefault();
            undoWaypoint();
            return;
        }

        const field = Math.max(1, numberValue('motion_focus_field_um', 20));
        const step = field / (event.shiftKey ? 20 : 200);
        if (direction === 'ArrowLeft') state.cursorFocusUm.x_um -= step;
        if (direction === 'ArrowRight') state.cursorFocusUm.x_um += step;
        if (direction === 'ArrowUp') state.cursorFocusUm.y_um += step;
        if (direction === 'ArrowDown') state.cursorFocusUm.y_um -= step;
        if (direction === 'Enter' || direction === ' ') {
            state.paths[state.activeSpot].push({ ...state.cursorFocusUm });
            setStatus(`光斑 ${state.activeSpot + 1} 路径点已添加`, 'info');
        }
        drawFocusPlot();
    }

    function bindControls() {
        const imageInput = byId('motion_image_input');
        if (imageInput) imageInput.addEventListener('change', () => loadMicroscopeFile(imageInput.files?.[0]));

        const microscope = byId('motion_microscope_canvas');
        if (microscope) {
            microscope.addEventListener('click', clickMicroscope);
            microscope.addEventListener('pointerdown', event => {
                if (!state.roiMode) return;
                const point = canvasImagePoint(microscope, event);
                if (!point) return;
                state.roiDragStart = point;
                state.roiDragCurrent = point;
                microscope.setPointerCapture(event.pointerId);
                drawMicroscope();
            });
            microscope.addEventListener('pointermove', event => {
                if (!state.roiMode || !state.roiDragStart) return;
                state.roiDragCurrent = canvasImagePoint(microscope, event);
                if (state.roiDragCurrent) drawMicroscope();
            });
            microscope.addEventListener('pointerup', finishRoiSelection);
            microscope.addEventListener('pointercancel', finishRoiSelection);
            microscope.addEventListener('keydown', event => keyboardCanvasAction(microscope, event, 'microscope'));
        }

        const cameraStart = byId('motion_camera_start_btn');
        if (cameraStart) cameraStart.addEventListener('click', () => startLiveMicroscope('camera'));
        const screenStart = byId('motion_screen_start_btn');
        if (screenStart) screenStart.addEventListener('click', () => startLiveMicroscope('screen'));
        const cameraStop = byId('motion_camera_stop_btn');
        if (cameraStop) cameraStop.addEventListener('click', stopLiveMicroscope);
        const roiButton = byId('motion_roi_button');
        if (roiButton) roiButton.addEventListener('click', () => {
            if (!state.image) {
                notify('请先启动实时画面或导入显微镜图像', 'warning');
                return;
            }
            state.roiMode = !state.roiMode;
            state.roiDragStart = null;
            state.roiDragCurrent = null;
            roiButton.classList.toggle('is-active', state.roiMode);
            roiButton.setAttribute('aria-pressed', String(state.roiMode));
            setStatus(state.roiMode ? '在画面中拖拽选择 ROI 区域' : '已退出 ROI 选择', 'info');
        });
        const scaleButton = byId('motion_scale_button');
        if (scaleButton) scaleButton.addEventListener('click', () => {
            if (!state.image) {
                notify('请先启动实时画面或导入显微镜图像', 'warning');
                return;
            }
            const reference = numberValue('motion_reference_distance_um', NaN);
            if (!(reference > 0)) {
                notify('请输入大于 0 的标尺实际长度', 'warning');
                return;
            }
            state.scaleMode = !state.scaleMode;
            state.scalePoints = [];
            scaleButton.classList.toggle('is-active', state.scaleMode);
            scaleButton.setAttribute('aria-pressed', String(state.scaleMode));
            const output = byId('motion_scale_status');
            if (output && state.scaleMode) output.textContent = '等待点击标尺两端点';
            setStatus(state.scaleMode ? '在 ROI 画面依次点击已知标尺的两个端点' : '已退出两点标定', 'info');
            drawMicroscope();
        });
        const focus = byId('motion_focus_canvas');
        if (focus) {
            focus.addEventListener('click', clickFocusPlot);
            focus.addEventListener('keydown', event => keyboardCanvasAction(focus, event, 'focus'));
        }

        const originButton = byId('motion_origin_button');
        if (originButton) originButton.addEventListener('click', () => {
            if (!state.image) {
                notify('请先导入显微镜图像', 'warning');
                return;
            }
            state.originMode = !state.originMode;
            originButton.classList.toggle('is-active', state.originMode);
            originButton.setAttribute('aria-pressed', String(state.originMode));
            setStatus(state.originMode ? '请在显微镜图像上点击标定原点' : '已退出原点设置', 'info');
        });

        const scaleInput = byId('motion_pixels_per_um');
        if (scaleInput) {
            const updateScale = () => {
                resetFeedbackForCalibrationChange();
                scaleCalibration();
                const value = numberValue('motion_pixels_per_um', NaN);
                const output = byId('motion_scale_status');
                if (output) output.textContent = value > 0
                    ? `手动比例：${(1 / value).toPrecision(6)} μm/px`
                    : '未完成距离标定';
            };
            scaleInput.addEventListener('input', updateScale);
            scaleInput.addEventListener('change', updateScale);
        }
        ['motion_focus_scale_x', 'motion_focus_scale_y'].forEach(id => {
            const input = byId(id);
            if (input) input.addEventListener('input', () => {
                resetFeedbackForCalibrationChange();
                drawFocusPlot();
                renderMarkers();
            });
        });
        const assignment = byId('motion_assign_select');
        if (assignment) assignment.addEventListener('change', () => {
            state.selectedMarkerId = assignment.value || null;
            renderMarkers();
            if (state.selectedMarkerId) assignSelectedMaterial(state.activeSpot);
        });
        const tabs = byId('motion_spot_tabs');
        if (tabs) tabs.addEventListener('click', event => {
            const button = event.target.closest('[data-spot-index]');
            if (!button) return;
            const index = Number(button.dataset.spotIndex);
            if (!Number.isInteger(index) || index < 0 || index >= 3) return;
            state.activeSpot = index;
            syncSpotTabs();
            if (state.feedbackMode) {
                setStatus(`选择光斑 ${index + 1}，然后在显微镜画面点选对应亮斑`, 'info');
            } else if (state.selectedMarkerId) assignSelectedMaterial(index);
            else drawFocusPlot();
        });

        ['motion_focus_field_um'].forEach(id => {
            const input = byId(id);
            if (input) input.addEventListener('input', drawFocusPlot);
        });
        const generate = byId('motion_generate_btn');
        if (generate) generate.addEventListener('click', generateJob);
        const undo = byId('motion_undo_waypoint');
        if (undo) undo.addEventListener('click', undoWaypoint);
        const clearPath = byId('motion_clear_path');
        if (clearPath) clearPath.addEventListener('click', clearActivePath);
        const addCgh = byId('motion_add_cgh_btn');
        if (addCgh) addCgh.addEventListener('click', addMotionFramesToCGH);
        const exportButton = byId('motion_export_btn');
        if (exportButton) exportButton.addEventListener('click', downloadExport);
        const feedbackMode = byId('motion_feedback_mode_btn');
        if (feedbackMode) feedbackMode.addEventListener('click', () => {
            if (state.feedbackMode) {
                state.feedbackMode = false;
                feedbackMode.classList.remove('is-active');
                feedbackMode.setAttribute('aria-pressed', 'false');
                setFeedbackReport('光斑测量已取消；已应用的补偿保留。', 'info');
                updateFeedbackButtons();
            } else {
                beginSpotFeedback();
            }
        });
        const applyFeedback = byId('motion_apply_feedback_btn');
        if (applyFeedback) applyFeedback.addEventListener('click', () => {
            try {
                applySpotFeedback();
            } catch (error) {
                setFeedbackReport(error.message, 'error');
            }
        });
        const clearFeedback = byId('motion_clear_feedback_btn');
        if (clearFeedback) clearFeedback.addEventListener('click', clearSpotFeedback);
        const upload = byId('motion_upload_btn');
        if (upload) upload.addEventListener('click', uploadToSLM);
        const previous = byId('motion_preview_prev');
        if (previous) previous.addEventListener('click', () => showPreview(state.previewIndex - 1));
        const next = byId('motion_preview_next');
        if (next) next.addEventListener('click', () => showPreview(state.previewIndex + 1));
    }

    function loadMicroscopeFile(file) {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            notify('请导入图像格式的显微镜图片', 'error');
            return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
            notify('显微镜图像超过 32 MiB 限制', 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => loadImageDataUrl(String(reader.result || ''));
        reader.onerror = () => notify('读取显微镜图像失败', 'error');
        reader.readAsDataURL(file);
    }

    function decodeImageDataUrl(dataUrl) {
        if (!dataUrl.startsWith('data:image/')) {
            return Promise.reject(new Error('显微镜图像格式无效'));
        }
        if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) {
            return Promise.reject(new Error('显微镜图像超过 32 MiB 限制'));
        }
        const image = new Image();
        return new Promise((resolve, reject) => {
            image.onload = () => {
                if (image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) {
                    reject(new Error('显微镜图像超过 16 MP 限制'));
                } else {
                    resolve(image);
                }
            };
            image.onerror = () => reject(new Error('显微镜图像无法解码'));
            image.src = dataUrl;
        });
    }

    async function loadImageDataUrl(dataUrl) {
        try {
            const image = await decodeImageDataUrl(dataUrl);
            stopLiveMicroscope();
            state.image = image;
            state.imageDataUrl = dataUrl;
            state.liveImageCaptured = false;
            state.roi = null;
            state.markers = [];
            state.selectedMarkerId = null;
            state.origin = null;
            state.originMode = false;
            state.assignments = [null, null, null];
            state.paths = [[], [], []];
            state.jobId = null;
            state.jobCalibration = null;
            state.jobFrames = [];
            state.phaseUrls = [];
            state.reconstructionUrls = [];
            state.previewIndex = 0;
            state.feedbackMode = false;
            state.feedbackMeasurements = [null, null, null];
            state.feedbackOffsets = [{ x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }];
            state.cursorImagePx = { x_px: image.naturalWidth / 2, y_px: image.naturalHeight / 2 };
            assignControlsEnabled(false);
            setProgress(0, '已导入显微镜图像');
            renderMarkers();
            setStatus(`已导入 ${image.naturalWidth} × ${image.naturalHeight} px 显微镜图像`, 'success');
            return true;
        } catch (error) {
            notify(error.message, 'error');
            return false;
        }
    }

    function buildPayload() {
        const pxPerUm = numberValue('motion_pixels_per_um', NaN);
        if (!state.image || !state.origin) throw new Error('请先导入显微镜图像并设置标定原点');
        if (!(pxPerUm > 0)) throw new Error('像素标定 px/μm 必须大于 0');
        if (state.assignments.some(value => !value)) throw new Error('请将三个光斑分别绑定到材料标记');
        if (state.paths.some(path => path.length < 1 || !path.every(finitePoint))) {
            throw new Error('三个光斑都需要至少一个有效路径点');
        }
        const parameters = {
            focal_length_um: numberValue('motion_focal_um', 1000),
            wavelength_nm: numberValue('motion_wavelength_nm', 532),
            magnification: numberValue('motion_magnification', 50),
            algorithm: byId('motion_algorithm')?.value || 'gaussian_wgs',
            phase_direction: byId('motion_phase_direction')?.value || 'standard',
            incident_beam_diameter_mm: numberValue('motion_beam_diameter_mm', 6),
            spot_diameter_um: numberValue('motion_spot_diameter_um', 6),
            width: numberValue('motion_width', 1272),
            height: numberValue('motion_height', 1024),
            speed_um_s: numberValue('motion_speed_um_s', 2),
            frame_interval_ms: numberValue('motion_frame_interval_ms', 100),
            iterations: numberValue('motion_iterations', 30),
            output_width: 512,
            output_height: 512
        };
        const paths = state.paths.map((waypoints, index) => ({
            id: `spot-${index + 1}`,
            material_id: state.assignments[index],
            waypoints: waypoints.map(point => ({
                x_um: point.x_um + state.feedbackOffsets[index].x_um,
                y_um: point.y_um + state.feedbackOffsets[index].y_um
            }))
        }));
        return {
            calibration: {
                origin_x_px: state.origin.x_px,
                origin_y_px: state.origin.y_px,
                pixels_per_um: pxPerUm,
                y_up: true,
                focus_scale_x: numberValue('motion_focus_scale_x', 1),
                focus_scale_y: numberValue('motion_focus_scale_y', 1),
                magnification: parameters.magnification
            },
            paths,
            parameters
        };
    }

    function readResponse(response) {
        return response.json().then(data => {
            if (!response.ok || data.success === false) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            return data;
        });
    }

    async function generateJob() {
        if (state.generating) return;
        let payload;
        try {
            payload = buildPayload();
        } catch (error) {
            setStatus(error.message, 'error');
            notify(error.message, 'warning');
            return;
        }
        state.generating = true;
        state.jobId = null;
        state.jobCalibration = null;
        state.jobFrames = [];
        state.phaseUrls = [];
        state.reconstructionUrls = [];
        state.previewIndex = 0;
        state.feedbackMode = false;
        state.feedbackMeasurements = [null, null, null];
        updateFeedbackButtons();
        assignControlsEnabled(false);
        activeInputsDisabled(true);
        setProgress(0, '正在提交路径规划…');
        try {
            const created = await fetch('/api/spot_motion/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(readResponse);
            state.jobId = created.job_id || created.id;
            if (!state.jobId) throw new Error('服务端没有返回任务编号');
            const frameCount = Number(created.frame_count);
            if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 200) {
                throw new Error('服务端返回了无效的帧数');
            }
            for (let index = 0; index < frameCount; index++) {
                const frame = await fetch(
                    `/api/spot_motion/jobs/${encodeURIComponent(state.jobId)}/next`,
                    { method: 'POST' }
                ).then(readResponse);
                if (['failed', 'error'].includes(frame.status)) {
                    throw new Error(frame.error || `第 ${index + 1} 帧生成失败`);
                }
                const complete = Number(frame.completed_frames || frame.completed || index + 1);
                setProgress(complete * 100 / frameCount,
                    `相位帧生成中：${complete}/${frameCount}`);
            }
            const finished = await fetch(`/api/spot_motion/jobs/${encodeURIComponent(state.jobId)}`)
                .then(readResponse);
            if (['failed', 'error'].includes(finished.status)) {
                throw new Error(finished.error || '相位帧生成失败');
            }
            state.phaseUrls = normalizeUrls(finished, 'phase_urls', state.jobId);
            state.reconstructionUrls = normalizeUrls(finished, 'reconstruction_urls', state.jobId);
            state.jobFrames = Array.isArray(finished.frames) ? finished.frames : [];
            state.jobCalibration = { ...payload.calibration };
            if (!state.phaseUrls.length) {
                state.phaseUrls = Array.from({ length: frameCount }, (_, index) =>
                    `/api/spot_motion/jobs/${encodeURIComponent(state.jobId)}/frames/${index}/phase`);
            }
            if (!state.reconstructionUrls.length) {
                state.reconstructionUrls = Array.from({ length: frameCount }, (_, index) =>
                    `/api/spot_motion/jobs/${encodeURIComponent(state.jobId)}/frames/${index}/reconstruction`);
            }
            setProgress(100, `完成：${frameCount} 帧相位图`);
            assignControlsEnabled(true);
            showPreview(0);
        } catch (error) {
            setStatus(`路径生成失败：${error.message}`, 'error');
            notify(`路径生成失败：${error.message}`, 'error');
        } finally {
            state.generating = false;
            activeInputsDisabled(false);
        }
    }

    function normalizeUrls(data, key, jobId) {
        const direct = data[key] || data[`${key}_urls`];
        if (Array.isArray(direct)) return direct;
        const frames = Array.isArray(data.frames) ? data.frames : [];
        const frameKey = key === 'phase_urls' ? 'phase_url' : 'reconstruction_url';
        if (frames.length && frames.every(frame => frame[frameKey])) {
            return frames.map(frame => frame[frameKey]);
        }
        const count = Number(data.frame_count || data.total_frames || 0);
        const resource = key === 'phase_urls' ? 'phase' : 'reconstruction';
        return count > 0
            ? Array.from({ length: count }, (_, index) =>
                `/api/spot_motion/jobs/${encodeURIComponent(jobId)}/frames/${index}/${resource}`)
            : [];
    }

    function showPreview(index) {
        if (!state.phaseUrls.length) return;
        const nextIndex = Math.max(0, Math.min(state.phaseUrls.length - 1, Number(index) || 0));
        if (nextIndex !== state.previewIndex) {
            state.feedbackMode = false;
            state.feedbackMeasurements = [null, null, null];
            const feedbackButton = byId('motion_feedback_mode_btn');
            if (feedbackButton) {
                feedbackButton.classList.remove('is-active');
                feedbackButton.setAttribute('aria-pressed', 'false');
            }
            setFeedbackReport('帧已切换，请针对当前帧重新测量三个光斑。', 'info');
        }
        state.previewIndex = nextIndex;
        const phase = byId('motion_phase_preview');
        const reconstruction = byId('motion_recon_preview');
        if (phase) phase.src = state.phaseUrls[state.previewIndex];
        if (reconstruction) {
            const url = state.reconstructionUrls[state.previewIndex];
            if (url) reconstruction.src = url;
            else reconstruction.removeAttribute('src');
        }
        const counter = byId('motion_frame_counter');
        if (counter) counter.textContent = `帧 ${state.previewIndex + 1}/${state.phaseUrls.length}`;
        const previous = byId('motion_preview_prev');
        const next = byId('motion_preview_next');
        if (previous) previous.disabled = state.previewIndex === 0;
        if (next) next.disabled = state.previewIndex === state.phaseUrls.length - 1;
        updateFeedbackButtons();
    }

    async function addMotionFramesToCGH() {
        if (state.addingToCgh) return false;
        if (!state.jobId || !state.phaseUrls.length) {
            notify('请先完成路径相位图生成', 'warning');
            return false;
        }
        if (typeof window.appendMotionJobToCGH !== 'function') {
            notify('CGH 序列交接接口尚未加载', 'error');
            return false;
        }
        const addButton = byId('motion_add_cgh_btn');
        state.addingToCgh = true;
        if (addButton) addButton.disabled = true;
        setStatus('正在将路径帧加入 CGH Simulation 序列…', 'info');
        try {
            const result = await window.appendMotionJobToCGH(state.jobId);
            if (result === false) throw new Error('CGH 序列未接收该任务');
            if (typeof window.showModule === 'function') window.showModule('cgh-simulation');
            setStatus(`已将 ${state.phaseUrls.length} 帧加入 CGH Simulation`, 'success');
            return true;
        } catch (error) {
            setStatus(`加入 CGH 序列失败：${error.message}`, 'error');
            notify(`加入 CGH 序列失败：${error.message}`, 'error');
            return false;
        } finally {
            state.addingToCgh = false;
            if (addButton) addButton.disabled = false;
        }
    }

    async function downloadExport() {
        if (!state.jobId || state.exporting) return;
        const url = `/api/spot_motion/jobs/${encodeURIComponent(state.jobId)}/export.zip`;
        const button = byId('motion_export_btn');
        state.exporting = true;
        if (button) button.disabled = true;
        setStatus('正在准备相位序列 ZIP…', 'info');
        try {
            const response = await fetch(url);
            if (!response.ok) {
                let message = `HTTP ${response.status}`;
                try {
                    const data = await response.json();
                    if (data.error) message = data.error;
                } catch (_) {}
                throw new Error(message);
            }
            const archive = await response.blob();
            if (!archive.size) throw new Error('服务端返回了空 ZIP 文件');
            const objectUrl = URL.createObjectURL(archive);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = `spot_motion_${state.jobId}.zip`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            setStatus('相位序列 ZIP 已开始下载', 'success');
        } catch (error) {
            setStatus(`导出 ZIP 失败：${error.message}`, 'error');
            notify(`导出 ZIP 失败：${error.message}`, 'error');
        } finally {
            state.exporting = false;
            if (button) button.disabled = false;
        }
    }

    async function uploadToSLM() {
        if (state.uploading) return;
        if (!state.jobId || !state.phaseUrls.length) {
            notify('请先完成路径相位图生成', 'warning');
            return;
        }
        const overwrite = byId('motion_usb_overwrite');
        if (!overwrite || !overwrite.checked) {
            notify('请勾选“确认覆盖指定 FMem 槽位”后再上传', 'warning');
            return;
        }
        if (!window.confirm(`将 ${state.phaseUrls.length} 帧写入指定的连续 FMem 槽位。现有槽位内容会被覆盖，继续吗？`)) {
            return;
        }
        const button = byId('motion_upload_btn');
        state.uploading = true;
        if (button) button.disabled = true;
        setStatus('正在上传相位帧到 USB_SLMControl…', 'info');
        try {
            const response = await fetch('/api/usb_slm/motion/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: state.jobId,
                    start_slot: numberValue('motion_usb_start_slot', 0),
                    overwrite_confirmed: true,
                    loop: true
                })
            }).then(readResponse);
            if (response.driver === 'sim') {
                throw new Error('当前连接是模拟驱动，不能执行实体 SLM 序列上传');
            }
            const mode = response.driver === 'sim' ? '模拟设备' : 'SLM 设备';
            const message = `${mode}已接受 ${response.uploaded_frames || state.phaseUrls.length} 帧；` +
                'USB 切槽时序不代表光斑运动速度已实测';
            setStatus(message, 'success');
            notify(message, 'success');
        } catch (error) {
            setStatus(`USB 上传失败：${error.message}`, 'error');
            notify(`USB 上传失败：${error.message}`, 'error');
        } finally {
            state.uploading = false;
            if (button) button.disabled = false;
        }
    }

    function getProjectState() {
        const params = {};
        ['motion_pixels_per_um', 'motion_focal_um', 'motion_wavelength_nm', 'motion_magnification',
            'motion_beam_diameter_mm', 'motion_spot_diameter_um', 'motion_width', 'motion_height',
            'motion_speed_um_s', 'motion_frame_interval_ms', 'motion_iterations',
            'motion_focus_scale_x', 'motion_focus_scale_y', 'motion_focus_field_um',
            'motion_detection_radius_px', 'motion_feedback_gain'].forEach(id => {
            const input = byId(id);
            if (input) params[id] = input.value;
        });
        ['motion_algorithm', 'motion_phase_direction'].forEach(id => {
            const input = byId(id);
            if (input) params[id] = input.value;
        });
        let imageDataUrl = state.imageDataUrl;
        if (state.image && (state.liveImageCaptured || state.roi)) {
            const roi = state.roi || { x: 0, y: 0, width: imageWidth(), height: imageHeight() };
            if (roi.width * roi.height > MAX_IMAGE_PIXELS) {
                throw new Error('实时画面 ROI 超过 16 MP，缩小 ROI 后再保存项目');
            }
            const snapshot = document.createElement('canvas');
            snapshot.width = roi.width;
            snapshot.height = roi.height;
            snapshot.getContext('2d').drawImage(
                state.image, roi.x, roi.y, roi.width, roi.height,
                0, 0, roi.width, roi.height
            );
            imageDataUrl = snapshot.toDataURL('image/png');
            if (imageDataUrl.length > MAX_IMAGE_BYTES * 1.4) {
                throw new Error('实时显微镜截图超过 32 MiB 项目图像限制');
            }
        }
        return {
            version: 1,
            image_data_url: imageDataUrl,
            markers: state.markers.map(marker => ({ ...marker })),
            selected_marker_id: state.selectedMarkerId,
            origin: state.origin ? { ...state.origin } : null,
            assignments: [...state.assignments],
            paths: state.paths.map(path => path.map(point => ({ ...point }))),
            feedback_offsets_um: state.feedbackOffsets.map(offset => ({ ...offset })),
            parameters: params
        };
    }

    async function restoreProjectState(project) {
        if (!project || project.version !== 1 || !Array.isArray(project.markers) ||
                project.markers.length > MAX_MARKERS || !Array.isArray(project.paths) ||
                project.paths.length !== 3 || !Array.isArray(project.assignments) ||
                project.assignments.length !== 3) {
            throw new Error('项目数据格式无效');
        }
        const markers = project.markers.map((marker, index) => {
            if (!marker || typeof marker.id !== 'string' ||
                    !Number.isFinite(Number(marker.x_px)) || !Number.isFinite(Number(marker.y_px))) {
                throw new Error(`第 ${index + 1} 个材料标记格式无效`);
            }
            if (Number(marker.x_px) < 0 || Number(marker.y_px) < 0) {
                throw new Error(`第 ${index + 1} 个材料标记坐标越界`);
            }
            return {
                id: marker.id,
                name: String(marker.name || `材料 ${index + 1}`).slice(0, 100),
                x_px: Number(marker.x_px),
                y_px: Number(marker.y_px)
            };
        });
        const paths = project.paths.map((path, index) => {
            if (!Array.isArray(path) || path.length > 1000 || !path.every(finitePoint)) {
                throw new Error(`光斑 ${index + 1} 路径数据格式无效`);
            }
            return path.map(point => ({ x_um: Number(point.x_um), y_um: Number(point.y_um) }));
        });
        const assignments = project.assignments.map(id =>
            id === null || markers.some(marker => marker.id === id) ? id : null);
        const feedbackOffsets = project.feedback_offsets_um === undefined
            ? [{ x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }]
            : project.feedback_offsets_um;
        if (!Array.isArray(feedbackOffsets) || feedbackOffsets.length !== 3 ||
                !feedbackOffsets.every(offset => offset &&
                    Number.isFinite(Number(offset.x_um)) && Number.isFinite(Number(offset.y_um)))) {
            throw new Error('项目光斑位置补偿数据无效');
        }
        const normalizedFeedbackOffsets = feedbackOffsets.map(offset => ({
            x_um: Number(offset.x_um), y_um: Number(offset.y_um)
        }));
        const origin = project.origin && Number.isFinite(Number(project.origin.x_px)) &&
            Number.isFinite(Number(project.origin.y_px)) &&
            Number(project.origin.x_px) >= 0 && Number(project.origin.y_px) >= 0
            ? { x_px: Number(project.origin.x_px), y_px: Number(project.origin.y_px) }
            : null;
        if (project.origin && !origin) throw new Error('项目标定原点格式无效');
        if (!project.image_data_url && (markers.length || origin)) {
            throw new Error('项目包含图像坐标，但缺少显微镜图像');
        }
        let restoredImage = null;
        if (project.image_data_url) {
            restoredImage = await decodeImageDataUrl(project.image_data_url);
            const outside = markers.some(marker => marker.x_px > restoredImage.naturalWidth ||
                marker.y_px > restoredImage.naturalHeight);
            if (outside || (origin && (origin.x_px > restoredImage.naturalWidth ||
                    origin.y_px > restoredImage.naturalHeight))) {
                throw new Error('项目中的标记或原点超出显微镜图像范围');
            }
        }

        stopLiveMicroscope();
        state.image = restoredImage;
        state.imageDataUrl = project.image_data_url || null;
        state.liveImageCaptured = false;
        state.roi = null;
        state.markers = markers;
        state.selectedMarkerId = markers.some(marker => marker.id === project.selected_marker_id)
            ? project.selected_marker_id : null;
        state.origin = origin;
        state.assignments = assignments;
        state.paths = paths;
        state.feedbackOffsets = normalizedFeedbackOffsets;
        state.jobId = null;
        state.jobCalibration = null;
        state.jobFrames = [];
        state.phaseUrls = [];
        state.reconstructionUrls = [];
        state.previewIndex = 0;
        state.feedbackMode = false;
        state.feedbackMeasurements = [null, null, null];
        state.activeSpot = 0;
        Object.entries(project.parameters || {}).forEach(([id, value]) => {
            const input = byId(id);
            if (input && typeof value === 'string' && !['motion_algorithm', 'motion_phase_direction'].includes(id)) {
                input.value = value;
            } else if (input && ['motion_algorithm', 'motion_phase_direction'].includes(id)) {
                input.value = String(value);
            }
        });
        scaleCalibration();
        syncSpotTabs();
        drawFocusPlot();
        assignControlsEnabled(false);
        return true;
    }

    function initialize() {
        if (state.initialized) return;
        const microscope = byId('motion_microscope_canvas');
        const focus = byId('motion_focus_canvas');
        if (!microscope || !focus) return;
        state.initialized = true;
        microscope.width = microscope.width || 960;
        microscope.height = microscope.height || 640;
        focus.width = focus.width || 960;
        focus.height = focus.height || 640;
        bindControls();
        scaleCalibration();
        renderMarkers();
        syncSpotTabs();
        drawFocusPlot();
        assignControlsEnabled(false);
        const phase = byId('motion_phase_preview');
        const reconstruction = byId('motion_recon_preview');
        if (phase) phase.alt = '当前帧的 SLM 相位图';
        if (reconstruction) reconstruction.alt = '当前帧的傅里叶重建结果';
    }

    window.initSpotMotion = initialize;
    window.addMotionFramesToCGH = addMotionFramesToCGH;
    window.SpotMotion = {
        state,
        initialize,
        buildPayload,
        getProjectState,
        restoreProjectState,
        generateJob,
        showPreview,
        addMotionFramesToCGH,
        sampleToFocusUm,
        beginSpotFeedback,
        recordSpotMeasurement,
        applySpotFeedback,
        clearSpotFeedback
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
