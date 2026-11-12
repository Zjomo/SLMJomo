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
        markers: [],
        selectedMarkerId: null,
        origin: null,
        originMode: false,
        activeSpot: 0,
        assignments: [null, null, null],
        paths: [[], [], []],
        jobId: null,
        phaseUrls: [],
        reconstructionUrls: [],
        previewIndex: 0,
        cursorImagePx: null,
        cursorFocusUm: { x_um: 0, y_um: 0 },
        generating: false,
        addingToCgh: false,
        uploading: false
    };

    function byId(id) {
        return document.getElementById(id);
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
        const output = byId('slam_status');
        if (!output) return;
        output.textContent = message;
        output.dataset.state = kind || 'info';
    }

    function setProgress(value, label) {
        const progress = byId('slam_progress');
        if (progress) {
            progress.max = 100;
            progress.value = Math.max(0, Math.min(100, Number(value) || 0));
            progress.setAttribute('aria-label', label || '相位帧生成进度');
        }
        if (label) {
            const output = byId('slam_status');
            if (output) output.textContent = label;
        }
    }

    function activeInputsDisabled(disabled) {
        ['slam_generate_btn', 'slam_image_input', 'slam_origin_button', 'slam_assign_select',
            'slam_focus_canvas'].forEach(id => {
            const element = byId(id);
            if (element) element.disabled = !!disabled;
        });
        const tabs = byId('slam_spot_tabs');
        if (tabs) tabs.querySelectorAll('button').forEach(button => { button.disabled = !!disabled; });
        const generate = byId('slam_generate_btn');
        if (generate) generate.disabled = !!disabled;
    }

    function assignControlsEnabled(enabled) {
        ['slam_add_cgh_btn', 'slam_export_btn', 'slam_upload_btn',
            'slam_preview_prev', 'slam_preview_next'].forEach(id => {
            const element = byId(id);
            if (element) element.disabled = !enabled;
        });
    }

    function finitePoint(point) {
        return point && Number.isFinite(Number(point.x_um)) && Number.isFinite(Number(point.y_um));
    }

    function scaleCalibration() {
        const scale = numberValue('slam_pixels_per_um', NaN);
        const reciprocal = byId('slam_um_per_px');
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
        return {
            x_px: Math.max(0, Math.min(state.image.naturalWidth,
                (canvasX - rect.x) / rect.scale)),
            y_px: Math.max(0, Math.min(state.image.naturalHeight,
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
        const pxPerUm = numberValue('slam_pixels_per_um', NaN);
        if (!(pxPerUm > 0) || !Number.isFinite(pxPerUm)) return null;
        const xScale = numberValue('slam_focus_scale_x', 1);
        const yScale = numberValue('slam_focus_scale_y', 1);
        return {
            x_um: ((xPx - state.origin.x_px) / pxPerUm) * xScale,
            y_um: ((state.origin.y_px - yPx) / pxPerUm) * yScale
        };
    }

    function drawMicroscope() {
        const canvas = byId('slam_microscope_canvas');
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#101820';
        context.fillRect(0, 0, canvas.width, canvas.height);
        state.imageDrawRect = null;

        if (state.image) {
            const scale = Math.min(canvas.width / state.image.naturalWidth,
                canvas.height / state.image.naturalHeight);
            const width = state.image.naturalWidth * scale;
            const height = state.image.naturalHeight * scale;
            const x = (canvas.width - width) / 2;
            const y = (canvas.height - height) / 2;
            state.imageDrawRect = { x, y, width, height, scale };
            context.drawImage(state.image, x, y, width, height);
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
    }

    function drawFocusPlot() {
        const canvas = byId('slam_focus_canvas');
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        const width = canvas.width;
        const height = canvas.height;
        const field = Math.max(1, numberValue('slam_focus_field_um', 20));
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
                context.strokeStyle = color;
                context.lineWidth = index === state.activeSpot ? 3 : 2;
                context.beginPath();
                path.forEach((point, pointIndex) => {
                    const position = toCanvas(point);
                    if (pointIndex === 0) context.moveTo(position.x, position.y);
                    else context.lineTo(position.x, position.y);
                });
                context.stroke();
                path.forEach((point, pointIndex) => {
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
        const list = byId('slam_marker_list');
        const select = byId('slam_assign_select');
        if (!list) return;

        list.replaceChildren();
        if (select) {
            const priorValue = state.selectedMarkerId || '';
            select.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '选择要分配的材料';
            select.append(placeholder);
        }

        if (!state.markers.length) {
            const empty = document.createElement('p');
            empty.className = 'slam-empty-state';
            empty.textContent = '尚未标记材料';
            list.append(empty);
        }

        state.markers.forEach((marker, index) => {
            const row = document.createElement('div');
            row.className = 'slam-marker-row' +
                (marker.id === state.selectedMarkerId ? ' is-selected' : '');
            const choose = document.createElement('button');
            choose.type = 'button';
            choose.className = 'slam-marker-select';
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
            remove.className = 'slam-marker-remove';
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
        const select = byId('slam_assign_select');
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
        const container = byId('slam_spot_tabs');
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
        const select = byId('slam_assign_select');
        if (select) select.value = marker.id;
        setStatus(`${marker.name} 已标记`, 'success');
    }

    function clickMicroscope(event) {
        const canvas = byId('slam_microscope_canvas');
        const point = canvas && sourcePointFromCanvas(canvas, event);
        if (!point) return;
        if (state.originMode) {
            state.origin = point;
            state.originMode = false;
            const button = byId('slam_origin_button');
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

    function focusPointFromCanvas(event) {
        const canvas = byId('slam_focus_canvas');
        if (!canvas) return null;
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return null;
        const pixelX = (event.clientX - bounds.left) * canvas.width / bounds.width;
        const pixelY = (event.clientY - bounds.top) * canvas.height / bounds.height;
        const field = Math.max(1, numberValue('slam_focus_field_um', 20));
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
                state.cursorImagePx = { x_px: state.image.naturalWidth / 2, y_px: state.image.naturalHeight / 2 };
            }
            const step = event.shiftKey ? 10 : 1;
            if (direction === 'ArrowLeft') state.cursorImagePx.x_px -= step;
            if (direction === 'ArrowRight') state.cursorImagePx.x_px += step;
            if (direction === 'ArrowUp') state.cursorImagePx.y_px -= step;
            if (direction === 'ArrowDown') state.cursorImagePx.y_px += step;
            state.cursorImagePx.x_px = Math.max(0, Math.min(state.image.naturalWidth, state.cursorImagePx.x_px));
            state.cursorImagePx.y_px = Math.max(0, Math.min(state.image.naturalHeight, state.cursorImagePx.y_px));
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

        const field = Math.max(1, numberValue('slam_focus_field_um', 20));
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
        const imageInput = byId('slam_image_input');
        if (imageInput) imageInput.addEventListener('change', () => loadMicroscopeFile(imageInput.files?.[0]));

        const microscope = byId('slam_microscope_canvas');
        if (microscope) {
            microscope.addEventListener('click', clickMicroscope);
            microscope.addEventListener('keydown', event => keyboardCanvasAction(microscope, event, 'microscope'));
        }
        const focus = byId('slam_focus_canvas');
        if (focus) {
            focus.addEventListener('click', clickFocusPlot);
            focus.addEventListener('keydown', event => keyboardCanvasAction(focus, event, 'focus'));
        }

        const originButton = byId('slam_origin_button');
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

        const scaleInput = byId('slam_pixels_per_um');
        if (scaleInput) {
            scaleInput.addEventListener('input', scaleCalibration);
            scaleInput.addEventListener('change', scaleCalibration);
        }
        ['slam_focus_scale_x', 'slam_focus_scale_y'].forEach(id => {
            const input = byId(id);
            if (input) input.addEventListener('input', () => {
                drawFocusPlot();
                renderMarkers();
            });
        });
        const assignment = byId('slam_assign_select');
        if (assignment) assignment.addEventListener('change', () => {
            state.selectedMarkerId = assignment.value || null;
            renderMarkers();
            if (state.selectedMarkerId) assignSelectedMaterial(state.activeSpot);
        });
        const tabs = byId('slam_spot_tabs');
        if (tabs) tabs.addEventListener('click', event => {
            const button = event.target.closest('[data-spot-index]');
            if (!button) return;
            const index = Number(button.dataset.spotIndex);
            if (!Number.isInteger(index) || index < 0 || index >= 3) return;
            state.activeSpot = index;
            syncSpotTabs();
            if (state.selectedMarkerId) assignSelectedMaterial(index);
            else drawFocusPlot();
        });

        ['slam_focus_field_um'].forEach(id => {
            const input = byId(id);
            if (input) input.addEventListener('input', drawFocusPlot);
        });
        const generate = byId('slam_generate_btn');
        if (generate) generate.addEventListener('click', generateJob);
        const undo = byId('slam_undo_waypoint');
        if (undo) undo.addEventListener('click', undoWaypoint);
        const clearPath = byId('slam_clear_path');
        if (clearPath) clearPath.addEventListener('click', clearActivePath);
        const addCgh = byId('slam_add_cgh_btn');
        if (addCgh) addCgh.addEventListener('click', addSLAMFramesToCGH);
        const exportButton = byId('slam_export_btn');
        if (exportButton) exportButton.addEventListener('click', downloadExport);
        const upload = byId('slam_upload_btn');
        if (upload) upload.addEventListener('click', uploadToSLM);
        const previous = byId('slam_preview_prev');
        if (previous) previous.addEventListener('click', () => showPreview(state.previewIndex - 1));
        const next = byId('slam_preview_next');
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
            state.image = image;
            state.imageDataUrl = dataUrl;
            state.markers = [];
            state.selectedMarkerId = null;
            state.origin = null;
            state.originMode = false;
            state.assignments = [null, null, null];
            state.paths = [[], [], []];
            state.jobId = null;
            state.phaseUrls = [];
            state.reconstructionUrls = [];
            state.previewIndex = 0;
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
        const pxPerUm = numberValue('slam_pixels_per_um', NaN);
        if (!state.image || !state.origin) throw new Error('请先导入显微镜图像并设置标定原点');
        if (!(pxPerUm > 0)) throw new Error('像素标定 px/μm 必须大于 0');
        if (state.assignments.some(value => !value)) throw new Error('请将三个光斑分别绑定到材料标记');
        if (state.paths.some(path => path.length < 1 || !path.every(finitePoint))) {
            throw new Error('三个光斑都需要至少一个有效路径点');
        }
        const parameters = {
            focal_length_um: numberValue('slam_focal_um', 1000),
            wavelength_nm: numberValue('slam_wavelength_nm', 532),
            magnification: numberValue('slam_magnification', 50),
            algorithm: byId('slam_algorithm')?.value || 'gaussian_wgs',
            phase_direction: byId('slam_phase_direction')?.value || 'standard',
            incident_beam_diameter_mm: numberValue('slam_beam_diameter_mm', 6),
            spot_diameter_um: numberValue('slam_spot_diameter_um', 6),
            width: numberValue('slam_width', 1272),
            height: numberValue('slam_height', 1024),
            speed_um_s: numberValue('slam_speed_um_s', 2),
            frame_interval_ms: numberValue('slam_frame_interval_ms', 100),
            iterations: numberValue('slam_iterations', 30),
            output_width: 512,
            output_height: 512
        };
        const paths = state.paths.map((waypoints, index) => ({
            id: `spot-${index + 1}`,
            material_id: state.assignments[index],
            waypoints: waypoints.map(point => ({ x_um: point.x_um, y_um: point.y_um }))
        }));
        return {
            calibration: {
                origin_x_px: state.origin.x_px,
                origin_y_px: state.origin.y_px,
                pixels_per_um: pxPerUm,
                y_up: true,
                focus_scale_x: numberValue('slam_focus_scale_x', 1),
                focus_scale_y: numberValue('slam_focus_scale_y', 1),
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
        state.phaseUrls = [];
        state.reconstructionUrls = [];
        state.previewIndex = 0;
        assignControlsEnabled(false);
        activeInputsDisabled(true);
        setProgress(0, '正在提交路径规划…');
        try {
            const created = await fetch('/api/slam/motion/jobs', {
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
                    `/api/slam/motion/jobs/${encodeURIComponent(state.jobId)}/next`,
                    { method: 'POST' }
                ).then(readResponse);
                if (['failed', 'error'].includes(frame.status)) {
                    throw new Error(frame.error || `第 ${index + 1} 帧生成失败`);
                }
                const complete = Number(frame.completed_frames || frame.completed || index + 1);
                setProgress(complete * 100 / frameCount,
                    `相位帧生成中：${complete}/${frameCount}`);
            }
            const finished = await fetch(`/api/slam/motion/jobs/${encodeURIComponent(state.jobId)}`)
                .then(readResponse);
            if (['failed', 'error'].includes(finished.status)) {
                throw new Error(finished.error || '相位帧生成失败');
            }
            state.phaseUrls = normalizeUrls(finished, 'phase_urls', state.jobId);
            state.reconstructionUrls = normalizeUrls(finished, 'reconstruction_urls', state.jobId);
            if (!state.phaseUrls.length) {
                state.phaseUrls = Array.from({ length: frameCount }, (_, index) =>
                    `/api/slam/motion/jobs/${encodeURIComponent(state.jobId)}/frames/${index}/phase`);
            }
            if (!state.reconstructionUrls.length) {
                state.reconstructionUrls = Array.from({ length: frameCount }, (_, index) =>
                    `/api/slam/motion/jobs/${encodeURIComponent(state.jobId)}/frames/${index}/reconstruction`);
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
                `/api/slam/motion/jobs/${encodeURIComponent(jobId)}/frames/${index}/${resource}`)
            : [];
    }

    function showPreview(index) {
        if (!state.phaseUrls.length) return;
        state.previewIndex = Math.max(0, Math.min(state.phaseUrls.length - 1, Number(index) || 0));
        const phase = byId('slam_phase_preview');
        const reconstruction = byId('slam_recon_preview');
        if (phase) phase.src = state.phaseUrls[state.previewIndex];
        if (reconstruction) {
            const url = state.reconstructionUrls[state.previewIndex];
            if (url) reconstruction.src = url;
            else reconstruction.removeAttribute('src');
        }
        const counter = byId('slam_frame_counter');
        if (counter) counter.textContent = `帧 ${state.previewIndex + 1}/${state.phaseUrls.length}`;
        const previous = byId('slam_preview_prev');
        const next = byId('slam_preview_next');
        if (previous) previous.disabled = state.previewIndex === 0;
        if (next) next.disabled = state.previewIndex === state.phaseUrls.length - 1;
    }

    async function addSLAMFramesToCGH() {
        if (state.addingToCgh) return false;
        if (!state.jobId || !state.phaseUrls.length) {
            notify('请先完成路径相位图生成', 'warning');
            return false;
        }
        if (typeof window.appendSLAMJobToCGH !== 'function') {
            notify('CGH 序列交接接口尚未加载', 'error');
            return false;
        }
        const addButton = byId('slam_add_cgh_btn');
        state.addingToCgh = true;
        if (addButton) addButton.disabled = true;
        setStatus('正在将路径帧加入 CGH Simulation 序列…', 'info');
        try {
            const result = await window.appendSLAMJobToCGH(state.jobId);
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

    function downloadExport() {
        if (!state.jobId) return;
        const url = `/api/slam/motion/jobs/${encodeURIComponent(state.jobId)}/export.zip`;
        const button = byId('slam_export_btn');
        if (button && button.tagName === 'A') {
            button.href = url;
            button.download = `slam_motion_${state.jobId}.zip`;
            return;
        }
        const link = document.createElement('a');
        link.href = url;
        link.download = `slam_motion_${state.jobId}.zip`;
        document.body.append(link);
        link.click();
        link.remove();
    }

    async function uploadToSLM() {
        if (state.uploading) return;
        if (!state.jobId || !state.phaseUrls.length) {
            notify('请先完成路径相位图生成', 'warning');
            return;
        }
        const overwrite = byId('slam_usb_overwrite');
        if (!overwrite || !overwrite.checked) {
            notify('请勾选“确认覆盖指定 FMem 槽位”后再上传', 'warning');
            return;
        }
        if (!window.confirm(`将 ${state.phaseUrls.length} 帧写入指定的连续 FMem 槽位。现有槽位内容会被覆盖，继续吗？`)) {
            return;
        }
        const button = byId('slam_upload_btn');
        state.uploading = true;
        if (button) button.disabled = true;
        setStatus('正在上传相位帧到 USB_SLMControl…', 'info');
        try {
            const response = await fetch('/api/usb_slm/motion/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: state.jobId,
                    start_slot: numberValue('slam_usb_start_slot', 0),
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
        ['slam_pixels_per_um', 'slam_focal_um', 'slam_wavelength_nm', 'slam_magnification',
            'slam_beam_diameter_mm', 'slam_spot_diameter_um', 'slam_width', 'slam_height',
            'slam_speed_um_s', 'slam_frame_interval_ms', 'slam_iterations',
            'slam_focus_scale_x', 'slam_focus_scale_y', 'slam_focus_field_um'].forEach(id => {
            const input = byId(id);
            if (input) params[id] = input.value;
        });
        ['slam_algorithm', 'slam_phase_direction'].forEach(id => {
            const input = byId(id);
            if (input) params[id] = input.value;
        });
        return {
            version: 1,
            image_data_url: state.imageDataUrl,
            markers: state.markers.map(marker => ({ ...marker })),
            selected_marker_id: state.selectedMarkerId,
            origin: state.origin ? { ...state.origin } : null,
            assignments: [...state.assignments],
            paths: state.paths.map(path => path.map(point => ({ ...point }))),
            parameters: params
        };
    }

    async function restoreProjectState(project) {
        if (!project || project.version !== 1 || !Array.isArray(project.markers) ||
                project.markers.length > MAX_MARKERS || !Array.isArray(project.paths) ||
                project.paths.length !== 3 || !Array.isArray(project.assignments) ||
                project.assignments.length !== 3) {
            throw new Error('SLAM 项目数据格式无效');
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

        state.image = restoredImage;
        state.imageDataUrl = project.image_data_url || null;
        state.markers = markers;
        state.selectedMarkerId = markers.some(marker => marker.id === project.selected_marker_id)
            ? project.selected_marker_id : null;
        state.origin = origin;
        state.assignments = assignments;
        state.paths = paths;
        state.jobId = null;
        state.phaseUrls = [];
        state.reconstructionUrls = [];
        state.previewIndex = 0;
        state.activeSpot = 0;
        Object.entries(project.parameters || {}).forEach(([id, value]) => {
            const input = byId(id);
            if (input && typeof value === 'string' && !['slam_algorithm', 'slam_phase_direction'].includes(id)) {
                input.value = value;
            } else if (input && ['slam_algorithm', 'slam_phase_direction'].includes(id)) {
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
        const microscope = byId('slam_microscope_canvas');
        const focus = byId('slam_focus_canvas');
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
        const phase = byId('slam_phase_preview');
        const reconstruction = byId('slam_recon_preview');
        if (phase) phase.alt = '当前帧的 SLM 相位图';
        if (reconstruction) reconstruction.alt = '当前帧的傅里叶重建结果';
    }

    window.initSLAMMotion = initialize;
    window.addSLAMFramesToCGH = addSLAMFramesToCGH;
    window.SLAMMotion = {
        state,
        initialize,
        buildPayload,
        getProjectState,
        restoreProjectState,
        generateJob,
        showPreview,
        addSLAMFramesToCGH,
        sampleToFocusUm
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
