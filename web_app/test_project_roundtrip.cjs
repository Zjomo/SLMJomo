const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {
    readProjectImageDimensions,
    projectImageDimensionsMatch
} = require('./static/js/project_image_utils.js');

function pngDataUri(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return `data:image/png;base64,${bytes.toString('base64')}`;
}

function makeElement(id) {
    return {
        id,
        type: id === 'focus_mm' ? 'number' : 'text',
        min: id === 'focus_mm' ? '1' : '',
        max: id === 'focus_mm' ? '5000' : '',
        value: id === 'focus_mm' ? '1000' : '',
        checked: false,
        disabled: false,
        style: {},
        dataset: {},
        children: [],
        closest(selector) { return selector === '.workspace' ? {} : null; },
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        removeAttribute(name) { delete this[name]; },
        setAttribute(name, value) { this[name] = value; },
        getContext() { return { drawImage() {} }; },
        click() { this.clicked = true; }
    };
}

const elements = new Map();
let savedBlob = null;
let displayedPhase = null;
const document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    },
    querySelector() { return makeElement('placeholder'); },
    querySelectorAll() { return []; },
    createElement(tag) { return makeElement(tag); },
    body: { append() {} }
};
const appState = {
    currentImageData: null,
    currentPatternType: null,
    uploadedImage: null,
    sequenceList: [],
    sequenceIndex: 0,
    isPlaying: false,
    playInterval: null,
    cghData: {
        targetImage: null,
        cghImage: null,
        regeneratedImage: null,
        lightShapeImage: null,
        filename: null
    }
};

const noop = () => {};
const context = vm.createContext({
    AppState: appState,
    document,
    Blob,
    URL: {
        createObjectURL(blob) { savedBlob = blob; return 'blob:project-test'; },
        revokeObjectURL: noop
    },
    setTimeout: noop,
    readProjectImageDimensions,
    projectImageDimensionsMatch,
    async loadPaintImage(data) {
        const { width, height } = readProjectImageDimensions(data);
        return { naturalWidth: width, naturalHeight: height };
    },
    captureProjectControls: () => ({ focus_mm: document.getElementById('focus_mm').value }),
    getSpotArrayProjectState: () => null,
    showNotification: noop,
    setWavelength: value => { document.getElementById('wavelength_nm').value = value; },
    toggleThreeSpotOptimization: noop,
    initializeThreeSpotDammannInfo: noop,
    toggleConverterSizeInputs: noop,
    toggleBeamRadiusInput: noop,
    updateCylindricalDiag: noop,
    updateDoubleRingRadiusLimits: noop,
    renderDoubleRingTargetPreview: noop,
    restoreSpotArrayProjectState: noop,
    removeImage() { appState.uploadedImage = null; },
    stopSequence: noop,
    updateSequenceList: noop,
    displayPhaseImage(data) { displayedPhase = data; },
    console
});

const mainSource = fs.readFileSync('./static/js/pro_main.js', 'utf8');
const projectStart = mainSource.indexOf('function serializeProjectImage');
const projectEnd = mainSource.indexOf('function loadRecentPattern', projectStart);
assert.notEqual(projectStart, -1, 'project serializer/importer source found');
assert.notEqual(projectEnd, -1, 'project importer section terminator found');
vm.runInContext(mainSource.slice(projectStart, projectEnd), context);

const target = pngDataUri(2, 2);
const phase = pngDataUri(3, 2);
const regenerated = pngDataUri(2, 3);
const lightShape = pngDataUri(1, 2);
appState.currentImageData = {
    image: phase,
    filename: 'phase.bmp',
    paramsDescription: 'f=1000mm, λ=532nm'
};
appState.currentPatternType = 'fresnel';
appState.cghData = {
    targetImage: target,
    cghImage: phase,
    regeneratedImage: regenerated,
    lightShapeImage: lightShape,
    filename: 'cgh-phase.bmp'
};
document.getElementById('cgh_target_path').value = 'target.png';
document.getElementById('info_focus').textContent = '1000 mm';
document.getElementById('info_wavelength').textContent = '532 nm';

context.saveWorkflowProject();
assert.ok(savedBlob, 'save creates a downloadable project blob');

(async () => {
    const project = JSON.parse(await savedBlob.text());
    assert.equal(project.version, 2);
    assert.equal(project.current_output.image, phase);
    assert.equal(project.current_output.infoFocus, '1000 mm');
    assert.equal(project.cgh.target_image, target);
    assert.equal(project.cgh.phase_image, null);
    assert.equal(project.cgh.phase_image_ref, 'current_output');
    assert.equal(project.cgh.regenerated_image, regenerated);
    assert.equal(project.cgh.light_shape_image, lightShape);

    document.getElementById('focus_mm').value = '1000';
    await context.restoreWorkflowProject(project);
    assert.equal(document.getElementById('focus_mm').value, '1000');
    assert.equal(appState.currentImageData.image, phase);
    assert.equal(appState.currentImageData.filename, 'phase.bmp');
    assert.equal(document.getElementById('info_focus').textContent, '1000 mm');
    assert.equal(document.getElementById('info_wavelength').textContent, '532 nm');
    assert.equal(displayedPhase, phase);
    assert.equal(appState.cghData.targetImage, target);
    assert.equal(appState.cghData.cghImage, phase);
    assert.equal(appState.cghData.regeneratedImage, regenerated);
    assert.equal(appState.cghData.lightShapeImage, lightShape);
    assert.equal(document.getElementById('cgh_target_path').value, 'target.png');

    const maximumImage = pngDataUri(4096, 4096);
    appState.currentImageData = { image: maximumImage, filename: 'large-cgh.bmp' };
    appState.currentPatternType = 'cgh';
    appState.cghData = {
        targetImage: maximumImage,
        cghImage: maximumImage,
        regeneratedImage: maximumImage,
        lightShapeImage: maximumImage,
        filename: 'large-cgh.bmp'
    };
    context.saveWorkflowProject();
    const maximumProject = JSON.parse(await savedBlob.text());
    assert.equal(maximumProject.cgh.phase_image_ref, 'current_output');
    assert.equal(maximumProject.current_output.infoFocus, 'CGH');
    assert.equal(maximumProject.current_output.infoWavelength, 'N/A');
    await context.restoreWorkflowProject(maximumProject);
    assert.equal(appState.cghData.cghImage, maximumImage);

    document.getElementById('focus_mm').value = '2222';
    appState.currentImageData = { image: target, filename: 'current.bmp' };
    const oversized = pngDataUri(8193, 1);
    await assert.rejects(context.restoreWorkflowProject({
        format: 'slmjomo-project',
        version: 2,
        controls: { focus_mm: '1500' },
        uploaded_image: null,
        sequence: [],
        current_output: { image: oversized },
        cgh: null
    }), /尺寸超过项目导入限制/);
    assert.equal(document.getElementById('focus_mm').value, '2222');
    assert.equal(appState.currentImageData.image, target);
    assert.equal(appState.cghData.cghImage, maximumImage);

    await context.restoreWorkflowProject({
        format: 'slmjomo-project',
        version: 1,
        controls: { focus_mm: '900' },
        uploaded_image: null,
        sequence: []
    });
    assert.equal(document.getElementById('focus_mm').value, '900');
    assert.equal(appState.currentImageData, null);
    assert.equal(appState.cghData.cghImage, null);
    assert.equal(document.getElementById('info_focus').textContent, 'N/A');
    assert.equal(document.getElementById('info_wavelength').textContent, 'N/A');
    assert.equal(document.getElementById('cgh_download_btn').disabled, true);
    assert.equal(document.getElementById('cgh_send_btn').disabled, true);

    process.stdout.write('Passed project v2 round-trip, v1 compatibility, and atomic image rejection checks.\n');
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
