const SpotArrayState = {
    spots: [],
    selectedIndex: -1,
    customized: false,
    legacyAlgorithm: null,
    draggingIndex: -1,
    bounds: { x: 1, y: 1 }
};

document.addEventListener('DOMContentLoaded', initializeSpotArrayEditor);

function initializeSpotArrayEditor() {
    const canvas = document.getElementById('three_spot_editor');
    if (!canvas) return;
    SpotArrayState.canvas = canvas;
    SpotArrayState.context = canvas.getContext('2d');
    SpotArrayState.legacyAlgorithm = document.getElementById('three_spot_algorithm').value;

    canvas.addEventListener('pointerdown', beginSpotDrag);
    canvas.addEventListener('pointermove', moveSpotDrag);
    canvas.addEventListener('pointerup', endSpotDrag);
    canvas.addEventListener('pointercancel', endSpotDrag);
    canvas.addEventListener('lostpointercapture', endSpotDrag);
    document.getElementById('three_spot_selected').addEventListener('change', event => {
        selectArraySpot(Number(event.target.value));
    });
    [['three_spot_x', 'x_mm'], ['three_spot_y', 'y_mm'], ['three_spot_weight', 'weight']]
        .forEach(([id, property]) => {
            document.getElementById(id).addEventListener('change', event => {
                updateSelectedSpot(property, Number(event.target.value));
            });
        });
    document.getElementById('three_spot_count').addEventListener('change', () => {
        if (!SpotArrayState.customized) resetSpotArray();
    });
    document.getElementById('three_spot_spacing').addEventListener('change', () => {
        if (!SpotArrayState.customized) resetSpotArray();
    });
    document.getElementById('three_spot_algorithm').addEventListener('change', event => {
        if (!SpotArrayState.customized) SpotArrayState.legacyAlgorithm = event.target.value;
    });
    [
        'three_spot_focus', 'three_spot_wavelength', 'three_spot_pixel_size',
        'three_spot_width', 'three_spot_height', 'three_spot_beam_diameter',
        'three_spot_radius'
    ].forEach(id => {
        document.getElementById(id).addEventListener('input', renderSpotArrayEditor);
    });
    resetSpotArray();
}

function getSpotArrayOptics(controlValues = null) {
    const value = id => Number(controlValues && Object.prototype.hasOwnProperty.call(controlValues, id)
        ? controlValues[id]
        : document.getElementById(id).value);
    const focal = value('three_spot_focus');
    const wavelength = value('three_spot_wavelength') / 1e6;
    const pixel = value('three_spot_pixel_size') / 1000;
    const width = value('three_spot_width');
    const height = value('three_spot_height');
    const beamRadius = value('three_spot_beam_diameter') / 2;
    if (![focal, wavelength, pixel, width, height, beamRadius].every(Number.isFinite) ||
        focal <= 0 || wavelength <= 0 || pixel <= 0 || width < 64 || height < 64 || beamRadius <= 0) {
        return { x: 0, y: 0, stepX: 0, stepY: 0, waist: 0 };
    }

    const stepX = wavelength * focal / (width * pixel);
    const stepY = wavelength * focal / (height * pixel);
    const halfX = Math.min(Math.floor(width / 2), Math.ceil(width / 2) - 1) * stepX;
    const halfY = Math.min(Math.floor(height / 2), Math.ceil(height / 2) - 1) * stepY;
    const minimumWaist = 0.8 * Math.max(stepX, stepY);
    const requestedWaist = value('three_spot_radius');
    const waist = Number.isFinite(requestedWaist) && requestedWaist > 0
        ? Math.max(minimumWaist, requestedWaist)
        : Math.max(wavelength * focal / (Math.PI * beamRadius), minimumWaist);
    const edgeMargin = Math.max(stepX, stepY) * 1e-6;
    return {
        x: Math.max(0, halfX - 2.5 * waist - edgeMargin),
        y: Math.max(0, halfY - 2.5 * waist - edgeMargin),
        stepX,
        stepY,
        waist
    };
}

function createDefaultSpotArray() {
    const countInput = document.getElementById('three_spot_count');
    const spacingInput = document.getElementById('three_spot_spacing');
    const count = Math.max(2, Math.min(15, Math.round(Number(countInput.value) || 3)));
    const spacing = Math.max(0.01, Number(spacingInput.value) || 1);
    const midpoint = (count - 1) / 2;
    return Array.from({ length: count }, (_, index) => ({
        id: `spot-${index + 1}`,
        x_mm: (index - midpoint) * spacing,
        y_mm: 0,
        weight: 1
    }));
}

function resetSpotArray() {
    SpotArrayState.spots = createDefaultSpotArray();
    SpotArrayState.selectedIndex = Math.floor(SpotArrayState.spots.length / 2);
    SpotArrayState.customized = false;
    const legacyPreview = document.getElementById('three_spot_target');
    legacyPreview.style.visibility = 'visible';
    legacyPreview.removeAttribute('aria-hidden');
    document.getElementById('three_spot_algorithm').value =
        SpotArrayState.legacyAlgorithm || 'uniform_grating';
    document.getElementById('three_spot_count').value = String(SpotArrayState.spots.length);
    document.getElementById('three_spot_count').disabled = false;
    document.getElementById('three_spot_spacing').disabled = false;
    updateSpotArraySelection();
    toggleThreeSpotOptimization();
    renderSpotArrayEditor();
}

function isSpotArrayCustomized() {
    return SpotArrayState.customized;
}

function getSpotArrayPayload() {
    if (!SpotArrayState.customized) return null;
    return SpotArrayState.spots.map(({ x_mm, y_mm, weight }) => ({ x_mm, y_mm, weight }));
}

function getSpotArrayProjectState() {
    return {
        customized: SpotArrayState.customized,
        legacyAlgorithm: SpotArrayState.legacyAlgorithm ||
            document.getElementById('three_spot_algorithm').value,
        spots: getSpotArrayPayload()
    };
}

function validateSpotArrayProjectState(snapshot, controlValues = null) {
    const algorithm = document.getElementById('three_spot_algorithm');
    if (snapshot === null || snapshot === undefined) {
        const legacyAlgorithm = controlValues &&
            Object.prototype.hasOwnProperty.call(controlValues, 'three_spot_algorithm')
            ? controlValues.three_spot_algorithm
            : algorithm.value;
        return { reset: true, legacyAlgorithm };
    }
    const supportedAlgorithms = Array.from(algorithm.options, option => option.value);
    if (!snapshot || typeof snapshot !== 'object' ||
        Array.isArray(snapshot) || typeof snapshot.customized !== 'boolean' ||
        !supportedAlgorithms.includes(snapshot.legacyAlgorithm)) {
        throw new Error('项目中的光斑阵列设置无效');
    }

    if (!snapshot.customized) {
        return { reset: true, legacyAlgorithm: snapshot.legacyAlgorithm };
    }

    if (!Array.isArray(snapshot.spots) || snapshot.spots.length < 2 || snapshot.spots.length > 15) {
        throw new Error('项目中的光斑数量必须在 2 到 15 之间');
    }
    const bounds = getSpotArrayOptics(controlValues);
    if (!bounds.x || !bounds.y || !bounds.waist) {
        throw new Error('项目中的光学参数无效');
    }
    const spots = snapshot.spots.map((spot, index) => {
        const x_mm = Number(spot?.x_mm);
        const y_mm = Number(spot?.y_mm);
        const weight = Number(spot?.weight);
        if (!Number.isFinite(x_mm) || !Number.isFinite(y_mm) ||
            !Number.isFinite(weight) || weight < 0.01 || weight > 10 ||
            Math.abs(x_mm) >= bounds.x || Math.abs(y_mm) >= bounds.y) {
            throw new Error(`项目中的第 ${index + 1} 个光斑参数无效`);
        }
        return { id: `spot-${Date.now()}-${index}`, x_mm, y_mm, weight };
    });
    for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
            if (Math.hypot(spots[i].x_mm - spots[j].x_mm, spots[i].y_mm - spots[j].y_mm) < 2 * bounds.waist) {
                throw new Error('项目中的光斑间距小于可分辨下限');
            }
        }
    }
    return { reset: false, legacyAlgorithm: snapshot.legacyAlgorithm, spots };
}

function restoreSpotArrayProjectState(snapshot, validatedState = null) {
    const algorithm = document.getElementById('three_spot_algorithm');
    const state = validatedState || validateSpotArrayProjectState(snapshot);
    SpotArrayState.legacyAlgorithm = state.legacyAlgorithm;
    if (state.reset) {
        algorithm.value = state.legacyAlgorithm;
        resetSpotArray();
        return;
    }

    algorithm.value = state.legacyAlgorithm;
    SpotArrayState.spots = state.spots;
    SpotArrayState.selectedIndex = 0;
    SpotArrayState.customized = false;
    setSpotArrayCustomized();
    updateSpotArraySelection();
    renderSpotArrayEditor();
}

function updateSpotArraySelection() {
    const select = document.getElementById('three_spot_selected');
    if (!select) return;
    select.replaceChildren(...SpotArrayState.spots.map((spot, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `光斑 ${index + 1}  (${spot.x_mm.toFixed(2)}, ${spot.y_mm.toFixed(2)})`;
        option.selected = index === SpotArrayState.selectedIndex;
        return option;
    }));
    document.getElementById('three_spot_remove').disabled = SpotArrayState.spots.length <= 2;
    const selected = SpotArrayState.spots[SpotArrayState.selectedIndex];
    [['three_spot_x', selected?.x_mm], ['three_spot_y', selected?.y_mm],
        ['three_spot_weight', selected?.weight]].forEach(([id, value]) => {
        const input = document.getElementById(id);
        input.disabled = !selected;
        input.value = selected ? Number(value).toFixed(2) : '';
    });
}

function selectArraySpot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= SpotArrayState.spots.length) return;
    SpotArrayState.selectedIndex = index;
    updateSpotArraySelection();
    renderSpotArrayEditor();
}

function setSpotArrayCustomized() {
    if (!SpotArrayState.customized) {
        SpotArrayState.legacyAlgorithm = document.getElementById('three_spot_algorithm').value;
    }
    SpotArrayState.customized = true;
    document.getElementById('three_spot_count').value = String(SpotArrayState.spots.length);
    document.getElementById('three_spot_count').disabled = true;
    document.getElementById('three_spot_spacing').disabled = true;
    const legacyPreview = document.getElementById('three_spot_target');
    legacyPreview.style.visibility = 'hidden';
    legacyPreview.setAttribute('aria-hidden', 'true');
    const algorithm = document.getElementById('three_spot_algorithm');
    algorithm.value = 'gaussian_wgs';
    toggleThreeSpotOptimization();
}

function updateSelectedSpot(property, value) {
    const spot = SpotArrayState.spots[SpotArrayState.selectedIndex];
    if (!spot || !Number.isFinite(value)) return;
    if (property === 'weight') {
        if (value < 0.01 || value > 10) {
            document.getElementById('three_spot_array_status').textContent = '相对强度范围为 0.01 到 10';
            document.getElementById('three_spot_array_status').classList.add('error');
            updateSpotArraySelection();
            return;
        }
        spot.weight = value;
    } else {
        const max = property === 'x_mm' ? SpotArrayState.bounds.x : SpotArrayState.bounds.y;
        spot[property] = Math.max(-max, Math.min(max, value));
    }
    setSpotArrayCustomized();
    updateSpotArraySelection();
    renderSpotArrayEditor();
}

function addArraySpot() {
    if (SpotArrayState.spots.length >= 15) return;
    const bounds = getSpotArrayOptics();
    const minDistance = Math.max(2 * bounds.waist, 0.1);
    let candidate = null;
    for (let ring = 1; ring <= 15 && !candidate; ring++) {
        for (let step = 0; step < ring * 8; step++) {
            const angle = step / (ring * 8) * Math.PI * 2;
            const point = {
                x_mm: Math.cos(angle) * ring * minDistance,
                y_mm: Math.sin(angle) * ring * minDistance
            };
            if (Math.abs(point.x_mm) > bounds.x || Math.abs(point.y_mm) > bounds.y) continue;
            const clear = SpotArrayState.spots.every(spot =>
                Math.hypot(spot.x_mm - point.x_mm, spot.y_mm - point.y_mm) >= minDistance
            );
            if (clear) {
                candidate = point;
                break;
            }
        }
    }
    if (!candidate) {
        setSpotArrayStatus('当前采样范围内没有足够空间添加可分辨的光斑', true);
        return;
    }
    SpotArrayState.spots.push({ id: `spot-${Date.now()}`, ...candidate, weight: 1 });
    SpotArrayState.selectedIndex = SpotArrayState.spots.length - 1;
    setSpotArrayCustomized();
    updateSpotArraySelection();
    renderSpotArrayEditor();
}

function removeSelectedArraySpot() {
    if (SpotArrayState.spots.length <= 2 || SpotArrayState.selectedIndex < 0) return;
    SpotArrayState.spots.splice(SpotArrayState.selectedIndex, 1);
    SpotArrayState.selectedIndex = Math.min(
        SpotArrayState.selectedIndex,
        SpotArrayState.spots.length - 1
    );
    setSpotArrayCustomized();
    updateSpotArraySelection();
    renderSpotArrayEditor();
}

function getSpotCanvasPoint(event) {
    const rect = SpotArrayState.canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * SpotArrayState.canvas.width / rect.width,
        y: (event.clientY - rect.top) * SpotArrayState.canvas.height / rect.height
    };
}

function spotToCanvas(spot) {
    const { left, right, top, bottom, width, height } = SpotArrayState.plot;
    return {
        x: left + (spot.x_mm + SpotArrayState.bounds.x) /
            (2 * SpotArrayState.bounds.x) * width,
        y: bottom - (spot.y_mm + SpotArrayState.bounds.y) /
            (2 * SpotArrayState.bounds.y) * height
    };
}

function canvasToSpot(point) {
    const { left, right, top, bottom, width, height } = SpotArrayState.plot;
    return {
        x_mm: Math.max(-SpotArrayState.bounds.x, Math.min(
            SpotArrayState.bounds.x,
            (point.x - left) / width * 2 * SpotArrayState.bounds.x - SpotArrayState.bounds.x
        )),
        y_mm: Math.max(-SpotArrayState.bounds.y, Math.min(
            SpotArrayState.bounds.y,
            (bottom - point.y) / height * 2 * SpotArrayState.bounds.y - SpotArrayState.bounds.y
        ))
    };
}

function beginSpotDrag(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = getSpotCanvasPoint(event);
    let closest = -1;
    let closestDistance = 18;
    SpotArrayState.spots.forEach((spot, index) => {
        const location = spotToCanvas(spot);
        const distance = Math.hypot(location.x - point.x, location.y - point.y);
        if (distance < closestDistance) {
            closest = index;
            closestDistance = distance;
        }
    });
    if (closest < 0) return;
    selectArraySpot(closest);
    SpotArrayState.draggingIndex = closest;
    SpotArrayState.canvas.setPointerCapture(event.pointerId);
    updateSpotFromCanvasPoint(point);
}

function moveSpotDrag(event) {
    if (SpotArrayState.draggingIndex < 0) return;
    event.preventDefault();
    updateSpotFromCanvasPoint(getSpotCanvasPoint(event));
}

function updateSpotFromCanvasPoint(point) {
    const spot = SpotArrayState.spots[SpotArrayState.draggingIndex];
    if (!spot) return;
    Object.assign(spot, canvasToSpot(point));
    setSpotArrayCustomized();
    updateSpotArraySelection();
    renderSpotArrayEditor();
}

function endSpotDrag(event) {
    if (SpotArrayState.draggingIndex < 0) return;
    SpotArrayState.draggingIndex = -1;
    if (event && SpotArrayState.canvas.hasPointerCapture(event.pointerId)) {
        SpotArrayState.canvas.releasePointerCapture(event.pointerId);
    }
}

function setSpotArrayStatus(message, isError = false) {
    const status = document.getElementById('three_spot_array_status');
    status.textContent = message;
    status.classList.toggle('error', isError);
}

function validateSpotArray() {
    const bounds = getSpotArrayOptics();
    if (!bounds.x || !bounds.y || !bounds.waist) return '请输入有效的光学参数和分辨率';
    const pixelCount = Number(document.getElementById('three_spot_width').value) *
        Number(document.getElementById('three_spot_height').value);
    const iterations = Number(document.getElementById('three_spot_iterations').value);
    if (pixelCount * SpotArrayState.spots.length > 20000000) {
        return '自由阵列点数与分辨率组合过大，请降低分辨率或点数';
    }
    if (pixelCount * iterations * (2 + 0.5 * SpotArrayState.spots.length) > 400000000) {
        return '自由阵列计算量过大，请降低分辨率、迭代次数或点数';
    }
    for (const spot of SpotArrayState.spots) {
        if (Math.abs(spot.x_mm) >= bounds.x || Math.abs(spot.y_mm) >= bounds.y) {
            return `光斑超出采样范围：X ±${bounds.x.toFixed(2)} mm，Y ±${bounds.y.toFixed(2)} mm`;
        }
    }
    for (let i = 0; i < SpotArrayState.spots.length; i++) {
        for (let j = i + 1; j < SpotArrayState.spots.length; j++) {
            const a = SpotArrayState.spots[i];
            const b = SpotArrayState.spots[j];
            if (Math.hypot(a.x_mm - b.x_mm, a.y_mm - b.y_mm) < 2 * bounds.waist) {
                return `光斑间距小于可分辨下限 ${(2 * bounds.waist).toFixed(2)} mm`;
            }
        }
    }
    return null;
}

function renderSpotArrayEditor() {
    const canvas = SpotArrayState.canvas;
    if (!canvas) return;
    const context = SpotArrayState.context;
    const width = canvas.width;
    const height = canvas.height;
    SpotArrayState.bounds = getSpotArrayOptics();
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#151a20';
    context.fillRect(0, 0, width, height);
    const margin = { left: 52, right: 14, top: 14, bottom: 32 };
    const plot = {
        left: margin.left,
        right: width - margin.right,
        top: margin.top,
        bottom: height - margin.bottom
    };
    plot.width = plot.right - plot.left;
    plot.height = plot.bottom - plot.top;
    SpotArrayState.plot = plot;

    context.strokeStyle = '#303a45';
    context.lineWidth = 1;
    context.beginPath();
    for (let index = 0; index <= 8; index++) {
        const x = plot.left + plot.width * index / 8;
        const y = plot.top + plot.height * index / 8;
        context.moveTo(x, plot.top);
        context.lineTo(x, plot.bottom);
        context.moveTo(plot.left, y);
        context.lineTo(plot.right, y);
    }
    context.stroke();
    context.strokeStyle = '#6f7b87';
    context.beginPath();
    context.moveTo(plot.left, plot.bottom - plot.height / 2);
    context.lineTo(plot.right, plot.bottom - plot.height / 2);
    context.moveTo(plot.left + plot.width / 2, plot.top);
    context.lineTo(plot.left + plot.width / 2, plot.bottom);
    context.stroke();
    context.fillStyle = '#aeb8c2';
    context.font = '12px Segoe UI, Microsoft YaHei, sans-serif';
    context.textAlign = 'center';
    context.fillText(`-${SpotArrayState.bounds.x.toFixed(1)}`, plot.left, height - 10);
    context.fillText(`X (mm)`, plot.right, height - 10);
    context.textAlign = 'left';
    context.fillText(`Y ±${SpotArrayState.bounds.y.toFixed(1)} mm`, 6, 14);

    const colors = ['#66d9ef', '#f6c85f', '#8bd17c', '#ed7d9a', '#aa94ed'];
    SpotArrayState.spots.forEach((spot, index) => {
        const point = spotToCanvas(spot);
        const selected = index === SpotArrayState.selectedIndex;
        const radius = 5;
        context.beginPath();
        context.arc(point.x, point.y, radius + (selected ? 3 : 0), 0, Math.PI * 2);
        context.strokeStyle = selected ? '#ffffff' : colors[index % colors.length];
        context.lineWidth = selected ? 2 : 1;
        context.stroke();
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = colors[index % colors.length];
        context.fill();
        context.fillStyle = '#101418';
        context.font = 'bold 11px Segoe UI, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(String(index + 1), point.x, point.y);
    });
    context.textBaseline = 'alphabetic';

    const custom = SpotArrayState.customized;
    const issue = validateSpotArray();
    const stateText = custom ? '自由位置 · Gaussian WGS' : '等间距阵列 · 原算法';
    setSpotArrayStatus(
        issue || `${stateText} · ${SpotArrayState.spots.length} 个光斑 · X ±${SpotArrayState.bounds.x.toFixed(2)} mm · Y ±${SpotArrayState.bounds.y.toFixed(2)} mm`,
        Boolean(issue)
    );
}
