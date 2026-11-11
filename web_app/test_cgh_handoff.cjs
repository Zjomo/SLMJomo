const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
const notifications = [];
const calls = [];
const context = vm.createContext({
    document: {
        addEventListener() {},
        createElement() { return { style: {}, textContent: '' }; },
        head: { appendChild() {} },
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: true });
            return elements.get(id);
        }
    },
    console,
    Date,
    showNotification(message, kind) { notifications.push({ message, kind }); },
    loadPaintImage: async () => ({ naturalWidth: 1920, naturalHeight: 1080 })
});

vm.runInContext(fs.readFileSync('./static/js/pro_main.js', 'utf8'), context);
context.showNotification = (message, kind) => notifications.push({ message, kind });
context.displayCGHTargetImage = image => calls.push(['target', image]);
context.generateLightShapePreview = () => calls.push(['light-preview']);
context.displayPhaseImage = image => calls.push(['phase', image]);

async function run() {
    vm.runInContext('loadPatternFromMain()', context);
    assert.equal(notifications.at(-1).kind, 'warning');

    vm.runInContext(`
        AppState.currentImageData = { image: 'data:image/png;base64,pattern', filename: 'pattern.png' };
        loadPatternFromMain();
    `, context);
    assert.equal(vm.runInContext('AppState.cghData.targetImage', context), 'data:image/png;base64,pattern');
    assert.equal(elements.get('cgh_target_path').value, '主程序: pattern.png');
    assert.deepEqual(calls.slice(0, 2), [
        ['target', 'data:image/png;base64,pattern'],
        ['light-preview']
    ]);
    assert.equal(notifications.at(-1).kind, 'success');

    vm.runInContext('loadCGHFromMain()', context);
    assert.equal(notifications.at(-1).kind, 'warning');

    vm.runInContext(`
        AppState.cghData.cghImage = 'data:image/png;base64,cgh';
        AppState.cghData.filename = 'cgh.bmp';
    `, context);
    await vm.runInContext('loadCGHFromMain()', context);
    assert.equal(vm.runInContext('AppState.currentPatternType', context), 'cgh');
    assert.equal(vm.runInContext('AppState.currentImageData.filename', context), 'cgh.bmp');
    assert.equal(elements.get('download_btn').disabled, false);
    assert.equal(elements.get('info_resolution').textContent, '1920 × 1080');
    assert.deepEqual(calls.at(-1), ['phase', 'data:image/png;base64,cgh']);
    assert.equal(notifications.at(-1).kind, 'success');

    process.stdout.write('Passed 4 CGH handoff checks.\n');
}

run().catch(error => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
});
