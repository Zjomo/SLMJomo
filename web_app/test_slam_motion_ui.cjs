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
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        querySelectorAll() { return []; },
        replaceChildren() {},
        append() {},
        appendChild() {},
        remove() {},
        click() {},
        getContext() {
            return {
                clearRect() {}, fillRect() {}, drawImage() {}, beginPath() {}, arc() {},
                fill() {}, stroke() {}, moveTo() {}, lineTo() {}, fillText() {}, setLineDash() {}
            };
        },
        getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 960, height: this.height || 640 }; }
    };
    elements.set(id, item);
    return item;
}

[
    ['slam_pixels_per_um', '2'], ['slam_um_per_px', '0.5'],
    ['slam_focal_um', '1000'], ['slam_wavelength_nm', '532'],
    ['slam_magnification', '50'], ['slam_algorithm', 'gaussian_wgs'],
    ['slam_phase_direction', 'standard'], ['slam_beam_diameter_mm', '6'],
    ['slam_spot_diameter_um', '6'], ['slam_width', '1272'], ['slam_height', '1024'],
    ['slam_speed_um_s', '2'], ['slam_frame_interval_ms', '100'],
    ['slam_iterations', '30'], ['slam_focus_scale_x', '1.5'],
    ['slam_focus_scale_y', '0.8'], ['slam_focus_field_um', '20'], ['slam_status', '']
].forEach(([id, value]) => element(id, value));

const document = {
    readyState: 'loading',
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {},
    createElement() { return element(`created-${Math.random()}`); },
    body: { append() {} }
};
let navigatedTo = null;
let appendedJobId = null;
const requests = [];
let nextFrame = 0;
async function fetchMock(url, options = {}) {
    requests.push({ url, method: options.method || 'GET' });
    if (url === '/api/slam/motion/jobs' && options.method === 'POST') {
        return { ok: true, status: 202, json: async () => ({ success: true, job_id: 'job-generated', frame_count: 2 }) };
    }
    if (url.endsWith('/next') && options.method === 'POST') {
        nextFrame++;
        return { ok: true, status: 200, json: async () => ({ success: true, completed_frames: nextFrame }) };
    }
    if (url === '/api/slam/motion/jobs/job-generated') {
        return { ok: true, status: 200, json: async () => ({ success: true, status: 'complete', frame_count: 2 }) };
    }
    throw new Error(`Unexpected fetch ${options.method || 'GET'} ${url}`);
}
const window = {
    showModule(id) { navigatedTo = id; },
    async appendSLAMJobToCGH(jobId) { appendedJobId = jobId; return true; },
    showNotification() {},
    confirm() { return true; },
    setTimeout
};
const context = { document, window, console, Number, Math, Promise, Array, String, Object, Error, setTimeout, fetch: fetchMock };
context.Image = class MockImage {
    constructor() { this.naturalWidth = 1200; this.naturalHeight = 800; }
    set src(value) { this._src = value; if (this.onload) this.onload(); }
    get src() { return this._src; }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/js/slam_motion.js', 'utf8'), context);

const motion = window.SLAMMotion;
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
    assert.equal(requests[1].url, '/api/slam/motion/jobs/job-generated/next');
    assert.equal(requests[2].url, '/api/slam/motion/jobs/job-generated/next');

    assert.equal(await motion.addSLAMFramesToCGH(), true);
    assert.equal(appendedJobId, 'job-generated');
    assert.equal(navigatedTo, 'cgh-simulation');

    const restored = motion.getProjectState();
    restored.paths[0][0].x_um = 42;
    await motion.restoreProjectState(saved);
    assert.equal(motion.state.paths[0][0].x_um, 1, 'project import restores stored path data');
    assert.equal(motion.state.imageDataUrl, 'data:image/png;base64,microscope');
    assert.equal(motion.state.jobId, null, 'job images are regenerated from saved path state');

    motion.state.paths[2] = [];
    assert.throws(() => motion.buildPayload(), /三个光斑都需要至少一个有效路径点/);

    const template = fs.readFileSync('templates/index_pro.html', 'utf8');
    const requiredIds = [
        'slam_image_input', 'slam_microscope_canvas', 'slam_origin_button', 'slam_marker_list',
        'slam_assign_select', 'slam_spot_tabs', 'slam_focus_canvas', 'slam_pixels_per_um',
        'slam_um_per_px', 'slam_focal_um', 'slam_wavelength_nm', 'slam_magnification',
        'slam_algorithm', 'slam_phase_direction', 'slam_beam_diameter_mm',
        'slam_spot_diameter_um', 'slam_width', 'slam_height', 'slam_speed_um_s',
        'slam_frame_interval_ms', 'slam_iterations', 'slam_focus_scale_x', 'slam_focus_scale_y',
        'slam_focus_field_um', 'slam_generate_btn', 'slam_add_cgh_btn', 'slam_export_btn',
        'slam_usb_start_slot', 'slam_usb_overwrite', 'slam_upload_btn', 'slam_status',
        'slam_progress', 'slam_frame_counter', 'slam_phase_preview', 'slam_recon_preview',
        'slam_preview_prev', 'slam_preview_next'
    ];
    requiredIds.forEach(id => assert.equal((template.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1,
        `template contains exactly one ${id}`));
    assert.match(template, /id="slam-motion"[\s\S]*id="cgh-simulation"/);
    assert.match(template, /css\/slam_motion\.css/);
    assert.match(template, /js\/slam_motion\.js/);
    process.stdout.write('SLAM motion UI contract: 6 checks passed\n');
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
