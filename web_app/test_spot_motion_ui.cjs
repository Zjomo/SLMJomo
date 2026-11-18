const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
function element(id, value = '') {
    const item = {
        id,
        value,
        textContent: '',
        dataset: {},
        disabled: false,
        width: id.endsWith('canvas') ? 960 : 0,
        height: id.endsWith('canvas') ? 640 : 0,
        listeners: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute(name, value) { this[name] = value; },
        removeAttribute() {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        querySelectorAll() { return []; },
        replaceChildren() {},
        append() {},
        appendChild() {},
        setPointerCapture() {},
        remove() {},
        click() {},
        getContext() {
            return {
                clearRect() {}, fillRect() {}, strokeRect() {}, drawImage() {}, beginPath() {}, arc() {},
                fill() {}, stroke() {}, moveTo() {}, lineTo() {}, fillText() {}, setLineDash() {}
            };
        },
        getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 960, height: this.height || 640 }; },
        getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 960, height: this.height || 640 }; }
    };
    elements.set(id, item);
    return item;
}

[
    ['motion_pixels_per_um', '2'], ['motion_um_per_px', '0.5'],
    ['motion_focal_um', '1000'], ['motion_wavelength_nm', '532'],
    ['motion_magnification', '50'], ['motion_algorithm', 'gaussian_wgs'],
    ['motion_phase_direction', 'standard'], ['motion_beam_diameter_mm', '6'],
    ['motion_spot_diameter_um', '6'], ['motion_width', '1272'], ['motion_height', '1024'],
    ['motion_speed_um_s', '2'], ['motion_frame_interval_ms', '100'],
    ['motion_iterations', '30'], ['motion_focus_scale_x', '1.5'],
    ['motion_focus_scale_y', '0.8'], ['motion_focus_field_um', '20'], ['motion_status', '']
    ,['motion_reference_distance_um', '50'], ['motion_pixels_per_um', '2'],
    ['motion_detection_radius_px', '16'], ['motion_feedback_gain', '0.75']
].forEach(([id, value]) => element(id, value));
[
    'motion_microscope_canvas', 'motion_focus_canvas', 'motion_marker_list', 'motion_assign_select',
    'motion_origin_button', 'motion_roi_button', 'motion_scale_button', 'motion_scale_status',
    'motion_camera_stop_btn', 'motion_camera_start_btn', 'motion_screen_start_btn',
    'motion_spot_tabs', 'motion_progress', 'motion_phase_preview', 'motion_recon_preview',
    'motion_feedback_mode_btn', 'motion_apply_feedback_btn', 'motion_clear_feedback_btn',
    'motion_feedback_report'
].forEach(id => element(id));

const document = {
    readyState: 'loading',
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {},
    createElement(tag) { const item = element(`created-${Math.random()}`); item.tagName = String(tag).toUpperCase(); return item; },
    body: { append() {} }
};
let navigatedTo = null;
let appendedJobId = null;
const requests = [];
let nextFrame = 0;
async function fetchMock(url, options = {}) {
    requests.push({ url, method: options.method || 'GET' });
    if (url === '/api/spot_motion/jobs' && options.method === 'POST') {
        return { ok: true, status: 202, json: async () => ({ success: true, job_id: 'job-generated', frame_count: 2 }) };
    }
    if (url.endsWith('/next') && options.method === 'POST') {
        nextFrame++;
        return { ok: true, status: 200, json: async () => ({ success: true, completed_frames: nextFrame }) };
    }
    if (url === '/api/spot_motion/jobs/job-generated') {
        return { ok: true, status: 200, json: async () => ({
            success: true, status: 'complete', frame_count: 2,
            frames: [0, 1].map(index => ({
                index,
                spots: [
                    { id: 'spot-1', x_um: 0, y_um: 0 },
                    { id: 'spot-2', x_um: 5, y_um: 6 },
                    { id: 'spot-3', x_um: -2, y_um: 7 }
                ],
                phase_url: `/phase/${index}`,
                reconstruction_url: `/reconstruction/${index}`
            }))
        }) };
    }
    throw new Error(`Unexpected fetch ${options.method || 'GET'} ${url}`);
}
const window = {
    showModule(id) { navigatedTo = id; },
    async appendMotionJobToCGH(jobId) { appendedJobId = jobId; return true; },
    showNotification() {},
    confirm() { return true; },
    setTimeout
};
const context = { document, window, console, Number, Math, Promise, Array, String, Object, Error, setTimeout, fetch: fetchMock,
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {} };
context.Image = class MockImage {
    constructor() { this.naturalWidth = 1200; this.naturalHeight = 800; }
    set src(value) { this._src = value; if (this.onload) this.onload(); }
    get src() { return this._src; }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/js/spot_vision.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('static/js/spot_motion.js', 'utf8'), context);

const motion = window.SpotMotion;
motion.initialize();
motion.state.image = { naturalWidth: 1200, naturalHeight: 800 };
motion.state.imageDataUrl = 'data:image/png;base64,microscope';
motion.state.origin = { x_px: 100, y_px: 200 };
motion.state.markers = [
    { id: 'm1', name: '材料 1', x_px: 110, y_px: 190 },
    { id: 'm2', name: '材料 2', x_px: 120, y_px: 180 },
    { id: 'm3', name: '材料 3', x_px: 130, y_px: 170 }
];
motion.state.assignments = ['m1', 'm2', 'm3'];
motion.state.paths = [
    [{ x_um: 1, y_um: 2 }, { x_um: 3, y_um: 4 }],
    [{ x_um: 5, y_um: 6 }],
    [{ x_um: -2, y_um: 7 }]
];

const payload = motion.buildPayload();
assert.equal(payload.calibration.pixels_per_um, 2);
assert.equal(payload.calibration.focus_scale_x, 1.5);
assert.equal(payload.calibration.focus_scale_y, 0.8);
assert.equal(payload.parameters.focal_length_um, 1000);
assert.equal(payload.parameters.incident_beam_diameter_mm, 6);
assert.equal(payload.parameters.width, 1272);
assert.equal(payload.paths.length, 3);
assert.equal(JSON.stringify(payload.paths[0].waypoints[1]), JSON.stringify({ x_um: 3, y_um: 4 }));

assert.equal(JSON.stringify(motion.sampleToFocusUm(110, 190)), JSON.stringify({ x_um: 7.5, y_um: 4 }));

elements.get('motion_scale_button').listeners.click[0]();
const microscope = elements.get('motion_microscope_canvas');
microscope.listeners.click[0]({ clientX: 100, clientY: 100 });
microscope.listeners.click[0]({ clientX: 300, clientY: 100 });
assert.equal(Number(elements.get('motion_pixels_per_um').value), 5,
    'two-point calibration converts known micrometre distance to px/um');
assert.equal(Number(elements.get('motion_um_per_px').value), 0.2);
assert.match(elements.get('motion_scale_status').textContent, /0\.200000 μm\/px/);

const saved = motion.getProjectState();
saved.paths[0][0].x_um = 999;
assert.equal(motion.state.paths[0][0].x_um, 1, 'project state must be a detached copy');
saved.paths[0][0].x_um = 1;

motion.state.jobId = 'job-test';
motion.state.phaseUrls = ['/phase/0'];
(async () => {
    await motion.generateJob();
    assert.equal(motion.state.jobId, 'job-generated');
    assert.equal(motion.state.phaseUrls.length, 2);
    assert.equal(requests.length, 4, 'job creation, two sequential frames, and final status');
    assert.equal(requests[1].url, '/api/spot_motion/jobs/job-generated/next');
    assert.equal(requests[2].url, '/api/spot_motion/jobs/job-generated/next');
    assert.equal(motion.state.jobFrames.length, 2);

    assert.equal(motion.beginSpotFeedback(), true);
    motion.recordSpotMeasurement(0, { x_px: 105, y_px: 195 }, { confidence: 0.9, area_px: 10 });
    motion.recordSpotMeasurement(1, { x_px: 121.6666666667, y_px: 157.5 });
    motion.recordSpotMeasurement(2, { x_px: 93.3333333333, y_px: 151.25 });
    const offsets = motion.applySpotFeedback();
    assert.ok(Math.abs(offsets[0].x_um + 1.125) < 1e-9);
    assert.ok(Math.abs(offsets[0].y_um + 0.6) < 1e-9);
    assert.ok(Math.abs(offsets[2].x_um) < 1e-9);
    assert.ok(Math.abs(offsets[2].y_um + 0.6) < 1e-9);
    const correctedPayload = motion.buildPayload();
    assert.ok(Math.abs(correctedPayload.paths[0].waypoints[0].x_um + 0.125) < 1e-9);
    assert.ok(Math.abs(correctedPayload.paths[0].waypoints[0].y_um - 1.4) < 1e-9);
    const correctedProject = motion.getProjectState();
    assert.ok(Math.abs(correctedProject.feedback_offsets_um[0].x_um + 1.125) < 1e-9);
    elements.get('motion_focus_scale_x').value = '2';
    assert.equal(motion.beginSpotFeedback(), false,
        'feedback measurements must use the calibration snapshot that generated the selected job');
    elements.get('motion_focus_scale_x').value = '1.5';

    assert.equal(await motion.addMotionFramesToCGH(), true);
    assert.equal(appendedJobId, 'job-generated');
    assert.equal(navigatedTo, 'cgh-simulation');

    const restored = motion.getProjectState();
    restored.paths[0][0].x_um = 42;
    await motion.restoreProjectState(saved);
    assert.equal(motion.state.paths[0][0].x_um, 1, 'project import restores stored path data');
    assert.equal(motion.state.imageDataUrl, 'data:image/png;base64,microscope');
    assert.equal(motion.state.jobId, null, 'job images are regenerated from saved path state');
    assert.deepEqual(JSON.parse(JSON.stringify(motion.state.feedbackOffsets)), [
        { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }, { x_um: 0, y_um: 0 }
    ]);

    motion.state.paths[2] = [];
    assert.throws(() => motion.buildPayload(), /三个光斑都需要至少一个有效路径点/);

    elements.get('motion_roi_button').listeners.click[0]();
    microscope.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 1 });
    microscope.listeners.pointermove[0]({ clientX: 300, clientY: 300, pointerId: 1 });
    microscope.listeners.pointerup[0]({ clientX: 300, clientY: 300, pointerId: 1 });
    assert.deepEqual(JSON.parse(JSON.stringify(motion.state.roi)), {
        x: 125, y: 125, width: 250, height: 250
    });
    assert.equal(motion.state.markers.length, 0, 'ROI changes reset old image-coordinate markers');

    const template = fs.readFileSync('templates/index_pro.html', 'utf8');
    const requiredIds = [
        'motion_image_input', 'motion_microscope_canvas', 'motion_origin_button', 'motion_marker_list',
        'motion_camera_start_btn', 'motion_screen_start_btn', 'motion_camera_stop_btn', 'motion_roi_button',
        'motion_reference_distance_um', 'motion_scale_button', 'motion_scale_status',
        'motion_assign_select', 'motion_spot_tabs', 'motion_focus_canvas', 'motion_pixels_per_um',
        'motion_um_per_px', 'motion_focal_um', 'motion_wavelength_nm', 'motion_magnification',
        'motion_algorithm', 'motion_phase_direction', 'motion_beam_diameter_mm',
        'motion_spot_diameter_um', 'motion_width', 'motion_height', 'motion_speed_um_s',
        'motion_frame_interval_ms', 'motion_iterations', 'motion_focus_scale_x', 'motion_focus_scale_y',
        'motion_focus_field_um', 'motion_generate_btn', 'motion_add_cgh_btn', 'motion_export_btn',
        'motion_usb_start_slot', 'motion_usb_overwrite', 'motion_upload_btn', 'motion_status',
        'motion_progress', 'motion_frame_counter', 'motion_phase_preview', 'motion_recon_preview',
        'motion_preview_prev', 'motion_preview_next', 'motion_detection_radius_px',
        'motion_feedback_gain', 'motion_feedback_mode_btn', 'motion_apply_feedback_btn',
        'motion_clear_feedback_btn', 'motion_feedback_report'
    ];
    requiredIds.forEach(id => assert.equal((template.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1,
        `template contains exactly one ${id}`));
    assert.match(template, /id="spot-motion"[\s\S]*id="cgh-simulation"/);
    assert.match(template, /css\/spot_motion\.css/);
    assert.match(template, /js\/spot_motion\.js/);
    assert.match(template, /js\/spot_vision\.js/);
    process.stdout.write('Spot motion UI contract: 6 checks passed\n');
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
