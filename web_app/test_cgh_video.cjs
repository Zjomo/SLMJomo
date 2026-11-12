const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// ==================== DOM 模拟 ====================
const elements = new Map();
const notifications = [];
const calls = [];
const timers = new Map();
let timerSeq = 0;
let objectUrlSeq = 0;
let objectUrlCalls = 0;
let throwOnObjectUrlCall = null;
const revokedObjectUrls = [];
const mockUrl = {
    createObjectURL(blob) {
        objectUrlCalls++;
        if (objectUrlCalls === throwOnObjectUrlCall) {
            throw new Error('simulated object URL failure');
        }
        return `blob:test-${++objectUrlSeq}-${blob.result || ''}`;
    },
    revokeObjectURL(url) { revokedObjectUrls.push(url); }
};

function runNextTimer() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    if (typeof timer === 'function') timer();
    else timer.fn();
    return timer;
}

function makeElement(id) {
    return {
        id,
        tagName: '',
        value: '',
        textContent: '',
        disabled: false,
        checked: false,
        max: '0',
        style: {},
        listeners: {},
        children: [],
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        append(...kids) {
            this.children.push(...kids);
        },
        replaceChildren() {
            this.children.length = 0;
        },
        remove() {},
        click() {},
        getContext() {
            return { clearRect() {}, drawImage() {} };
        }
    };
}

const context = vm.createContext({
    document: {
        addEventListener() {},
        head: { appendChild() {} },
        createElement(tag) {
            const el = makeElement('');
            el.tagName = tag;
            return el;
        },
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id));
            return elements.get(id);
        },
        querySelector() { return null; },
        body: { append() {}, appendChild() {} }
    },
    window: {
        URL: mockUrl,
        confirm: () => true
    },
    URL: mockUrl,
    console,
    Date,
    Math,
    Image: class MockImage {
        set src(v) { this._src = v; }
        get src() { return this._src; }
    },
    atob,
    setInterval(fn) {
        const id = ++timerSeq;
        timers.set(id, fn);
        return id;
    },
    clearInterval(id) {
        timers.delete(id);
    },
    setTimeout(fn, delay) {
        const id = ++timerSeq;
        timers.set(id, { fn, delay });
        return id;
    },
    clearTimeout(id) {
        timers.delete(id);
    },
    FileReader: class MockFileReader {
        readAsDataURL(file) {
            this.result = file.dataUri || file.result;
            if (this.onload) this.onload();
        }
    },
    showNotification(message, kind) { notifications.push({ message, kind }); },
    displayPhaseImage(image) { calls.push(['phase', image]); }
});

// project_image_utils.js 为 UMD：在无 module 的 vm 环境中挂到 globalThis
vm.runInContext(
    fs.readFileSync('./static/js/project_image_utils.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('./static/js/pro_main.js', 'utf8'), context);
context.showNotification = (message, kind) => notifications.push({ message, kind });
context.displayPhaseImage = image => calls.push(['phase', image]);
// loadPaintImage 依赖 Image 加载，测试中直接按 PNG 头返回尺寸
vm.runInContext(`
    globalThis.loadPaintImage = async (data) => {
        const dims = readProjectImageDimensions(data);
        return { naturalWidth: dims.width, naturalHeight: dims.height };
    };
`, context);

function makePngDataUri(width = 4, height = 4) {
    const buf = Buffer.alloc(33);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
    buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[24] = 8; buf[25] = 0; buf[26] = 0; buf[27] = 0; buf[28] = 0;
    return 'data:image/png;base64,' + buf.toString('base64');
}

function lastNotification() {
    return notifications.at(-1);
}

async function run() {
    const pngA = makePngDataUri();
    const pngB = makePngDataUri(8, 6);
    context.pngA = pngA;

    // ---------- 1. 加入当前 CGH ----------
    vm.runInContext('addCurrentCGHToVideo()', context);
    assert.equal(lastNotification().kind, 'warning');

    vm.runInContext(`
        AppState.cghData = {
            targetImage: 'data:image/png;base64,target',
            cghImage: 'data:image/png;base64,cgh',
            regeneratedImage: 'data:image/png;base64,regen',
            lightShapeImage: null,
            filename: 'frame.bmp'
        };
        addCurrentCGHToVideo();
    `, context);
    assert.equal(vm.runInContext('AppState.cghVideo.frames.length', context), 1);
    let frame = vm.runInContext('AppState.cghVideo.frames[0]', context);
    assert.equal(frame.phase, 'data:image/png;base64,cgh');
    assert.equal(frame.label, '当前CGH: frame.bmp');
    assert.equal(lastNotification().kind, 'success');

    // ---------- 2. 导入目标图（多选） ----------
    vm.runInContext(`
        handleCGHVideoFiles([
            { type: 'image/png', name: 'a.png', dataUri: ${JSON.stringify(pngA)} },
            { type: 'text/plain', name: 'note.txt' },
            { type: 'image/jpeg', name: 'b.jpg', dataUri: ${JSON.stringify(pngB)} }
        ]);
    `, context);
    assert.equal(vm.runInContext('AppState.cghVideo.frames.length', context), 3);
    frame = vm.runInContext('AppState.cghVideo.frames[2]', context);
    assert.equal(frame.target, pngB);
    assert.equal(frame.phase, null);
    assert.equal(frame.label, 'b.jpg');
    assert.equal(lastNotification().kind, 'success');

    // 帧数上限
    vm.runInContext('AppState.cghVideo.frames = Array.from({length: 200}, (_, i) => ({ id: i, phase: null, target: null }))', context);
    vm.runInContext(`handleCGHVideoFiles([{ type: 'image/png', name: 'x.png', dataUri: '${pngA}' }])`, context);
    assert.equal(lastNotification().kind, 'warning');
    assert.equal(vm.runInContext('AppState.cghVideo.frames.length', context), 200);

    // ---------- 3. 帧管理：移动 / 删除 / 清空 ----------
    vm.runInContext(`
        AppState.cghVideo.frames = [
            { id: 1, phase: 'p1', target: null, regenerated: null, filename: '', label: 'one' },
            { id: 2, phase: 'p2', target: null, regenerated: null, filename: '', label: 'two' },
            { id: 3, phase: 'p3', target: null, regenerated: null, filename: '', label: 'three' }
        ];
        renderCGHVideoFrames();
    `, context);
    vm.runInContext('moveCGHVideoFrame(3, -1)', context);
    assert.equal(
        JSON.stringify(vm.runInContext('AppState.cghVideo.frames.map(f => f.id)', context)),
        JSON.stringify([1, 3, 2]));
    vm.runInContext('removeCGHVideoFrame(1)', context);
    assert.equal(
        JSON.stringify(vm.runInContext('AppState.cghVideo.frames.map(f => f.id)', context)),
        JSON.stringify([3, 2]));
    vm.runInContext('clearCGHVideoFrames()', context);
    assert.equal(vm.runInContext('AppState.cghVideo.frames.length', context), 0);
    assert.equal(lastNotification().kind, 'info');

    // ---------- 4. 播放控制 ----------
    vm.runInContext("document.getElementById('cgh_video_display_mode').value = 'phase'", context);
    vm.runInContext('playCGHVideo()', context);
    assert.equal(lastNotification().kind, 'warning'); // 空序列

    vm.runInContext(`
        AppState.cghVideo.frames = [
            { id: 1, phase: null, target: 't1', regenerated: null, filename: '', label: '', duration_ms: 75 },
            { id: 2, phase: null, target: 't2', regenerated: 'r2', filename: '', label: '', duration_ms: 125 }
        ];
        renderCGHVideoFrames();
        playCGHVideo();
    `, context);
    assert.equal(lastNotification().kind, 'warning'); // 无已计算帧

    vm.runInContext('AppState.cghVideo.frames[0].phase = "p1"; playCGHVideo();', context);
    assert.equal(lastNotification().kind, 'info');
    assert.equal(timers.size, 1);
    assert.equal(elements.get('cgh_video_play_btn').disabled, true);
    assert.equal(elements.get('cgh_video_pause_btn').disabled, false);
    assert.equal(elements.get('cgh_video_frame_indicator').textContent, '帧 1/2');
    assert.equal(vm.runInContext('AppState.cghVideo.index', context), 1);
    assert.deepEqual(calls.at(-1), ['phase', 'p1']);
    assert.equal(timers.values().next().value.delay, 75);

    // 循环回绕
    vm.runInContext('AppState.cghVideo.frames[1].phase = "p2"', context);
    runNextTimer();
    assert.equal(elements.get('cgh_video_frame_indicator').textContent, '帧 2/2');
    assert.deepEqual(calls.at(-1), ['phase', 'p2']);
    assert.equal(timers.values().next().value.delay, 125);
    runNextTimer();
    assert.equal(elements.get('cgh_video_frame_indicator').textContent, '帧 1/2');

    // 暂停 / 停止
    vm.runInContext('pauseCGHVideo()', context);
    assert.equal(timers.size, 0);
    assert.equal(elements.get('cgh_video_play_btn').disabled, false);
    assert.equal(elements.get('cgh_video_pause_btn').disabled, true);
    vm.runInContext('stopCGHVideo()', context);
    assert.equal(vm.runInContext('AppState.cghVideo.index', context), 0);

    // ---------- 5. 批量计算 ----------
    let fetchCalls = 0;
    context.fetch = async (url, options) => {
        fetchCalls++;
        assert.equal(url, '/api/cgh/calculate');
        const body = JSON.parse(options.body);
        assert.equal(body.target_image, 't1');
        return {
            ok: true,
            json: async () => ({
                success: true,
                cgh_image: 'calc-p1',
                regenerated_image: 'calc-r1',
                filename: 'frame_1.bmp'
            })
        };
    };
    vm.runInContext(`
        AppState.cghVideo.frames = [
            { id: 1, phase: null, target: 't1', regenerated: null, filename: '', label: 'a' },
            { id: 2, phase: 'p2', target: 't2', regenerated: null, filename: '', label: 'b' }
        ];
    `, context);
    await vm.runInContext('calculateCGHVideoSequence()', context);
    assert.equal(fetchCalls, 1); // 已计算的帧被跳过
    assert.equal(vm.runInContext('AppState.cghVideo.frames[0].phase', context), 'calc-p1');
    assert.equal(vm.runInContext('AppState.cghVideo.frames[0].filename', context), 'frame_1.bmp');
    assert.equal(lastNotification().kind, 'success');

    // 全部已计算时提示
    await vm.runInContext('calculateCGHVideoSequence()', context);
    assert.equal(lastNotification().kind, 'info');
    assert.equal(fetchCalls, 1);

    // ---------- 6. 序列化 ----------
    vm.runInContext(`
        AppState.cghVideo.frames = [
            { id: 11, phase: ${JSON.stringify(pngA)}, target: ${JSON.stringify(pngB)},
              regenerated: null, filename: '', label: 'a' },
            { id: 12, phase: null, target: ${JSON.stringify(pngA)},
              regenerated: null, filename: '', label: 'b' }
        ];
    `, context);
    const budget2 = { pixels: 0 };
    context.serializeBudget = budget2;
    const saved = vm.runInContext('serializeProjectCGHVideo(serializeBudget)', context);
    assert.equal(saved.frames.length, 2);
    assert.equal(saved.frames[0].phase, pngA);
    assert.equal(saved.frames[0].target, pngB);
    assert.equal(saved.frames[0].regenerated, null);
    assert.equal(saved.frames[1].phase, null);
    assert.equal(saved.frames[1].target, pngA);
    // 像素预算：4x4 + 8x6 + 4x4 = 16 + 48 + 16 = 80
    assert.equal(budget2.pixels, 80);

    // ---------- 7. 恢复 ----------
    const restoredEmpty = await vm.runInContext('restoreProjectCGHVideo(null, serializeBudget)', context);
    assert.equal(JSON.stringify(restoredEmpty), JSON.stringify([]));

    await assert.rejects(
        vm.runInContext('restoreProjectCGHVideo({}, serializeBudget)', context),
        /视频序列格式无效/
    );
    await assert.rejects(
        vm.runInContext(`restoreProjectCGHVideo({ frames: [{}] }, serializeBudget)`, context),
        /缺少图像/
    );
    await assert.rejects(
        vm.runInContext(`
            restoreProjectCGHVideo(
                { frames: Array.from({length: 201}, () => ({ phase: ${JSON.stringify(pngA)} })) },
                serializeBudget)
        `, context),
        /帧数过多/
    );

    const budget3 = { pixels: 0 };
    context.restoreBudget = budget3;
    const restored = await vm.runInContext(
        'restoreProjectCGHVideo({ frames: serializeProjectCGHVideo(serializeBudget).frames }, restoreBudget)',
        context
    );
    assert.equal(restored.length, 2);
    assert.equal(restored[0].phase, pngA);
    assert.equal(restored[0].target, pngB);
    assert.equal(restored[0].regenerated, null);
    assert.equal(restored[1].phase, null);
    assert.equal(restored[1].target, pngA);
    assert.equal(budget3.pixels, 80);

    // ---------- 8. SLAM 预计算相位序列交接 ----------
    const slamFrames = [
        { phase_url: '/phase/0', reconstruction_url: '/recon/0', time_s: 0, duration_ms: 120, spots: [] },
        { phase_url: '/phase/1', reconstruction_url: '/recon/1', time_s: 0.12, duration_ms: 100, spots: [] }
    ];
    const slamRequests = [];
    vm.runInContext('AppState.cghVideo.frames = [];', context);
    context.fetch = async url => {
        slamRequests.push(url);
        if (url === '/api/slam/motion/jobs/job-1') {
            return { ok: true, json: async () => ({ status: 'complete', frame_count: 2, frames: slamFrames }) };
        }
        return {
            ok: true,
            blob: async () => ({ result: url.startsWith('/phase') ? pngA : pngB })
        };
    };
    const added = await context.appendSLAMJobToCGH('job-1');
    assert.equal(added, 2);
    assert.equal(vm.runInContext('AppState.cghVideo.frames.length', context), 2);
    assert.match(vm.runInContext('AppState.cghVideo.frames[0].phase', context), /^blob:/);
    assert.match(vm.runInContext('AppState.cghVideo.frames[0].regenerated', context), /^blob:/);
    assert.equal(vm.runInContext('AppState.cghVideo.frames[0].duration_ms', context), 120);
    assert.equal(vm.runInContext('AppState.cghVideo.frames[0].source', context), 'slam');
    assert.equal(elements.get('cgh_video_display_mode').value, 'regenerated');
    assert.equal(slamRequests.length, 5, 'one job status and two assets per frame');

    vm.runInContext('AppState.cghVideo.frames = Array.from({length: 199}, () => ({ phase: pngA }));', context);
    const requestCountBeforeCapacityCheck = slamRequests.length;
    await assert.rejects(context.appendSLAMJobToCGH('job-1'), /容量不足/);
    assert.equal(slamRequests.length, requestCountBeforeCapacityCheck + 1,
        'capacity is checked before downloading frame assets');

    vm.runInContext('AppState.cghVideo.frames = [];', context);
    await context.appendSLAMJobToCGH('job-1');
    const phaseObjectUrl = vm.runInContext('AppState.cghVideo.frames[0].phase', context);
    vm.runInContext('removeCGHVideoFrame(AppState.cghVideo.frames[0].id)', context);
    assert.ok(revokedObjectUrls.includes(phaseObjectUrl), 'removing a SLAM frame releases its object URL');

    // A reconstruction URL failure must also release the phase URL created
    // immediately before it.
    vm.runInContext('AppState.cghVideo.frames = [];', context);
    const revokedBeforePartialImport = revokedObjectUrls.length;
    throwOnObjectUrlCall = objectUrlCalls + 2;
    await assert.rejects(context.appendSLAMJobToCGH('job-1'), /simulated object URL failure/);
    throwOnObjectUrlCall = null;
    assert.equal(revokedObjectUrls.length, revokedBeforePartialImport + 1);
    assert.match(revokedObjectUrls.at(-1), /^blob:/);

    process.stdout.write('Passed CGH video sequence and SLAM handoff checks.\n');
}

run().catch(error => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
});
