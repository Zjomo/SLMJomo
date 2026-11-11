const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeControl(id, options = {}) {
    return {
        id,
        type: options.type || 'number',
        tagName: options.tagName || 'INPUT',
        min: options.min ?? '0',
        max: options.max ?? '4096',
        value: options.value ?? '',
        checked: false,
        options: (options.values || []).map(value => ({ value })),
        closest: selector => selector === '.workspace' ? {} : null
    };
}

const controls = new Map([
    ['focus_mm', makeControl('focus_mm', { min: '1', max: '5000', value: '1000' })],
    ['wavelength_nm', makeControl('wavelength_nm', {
        type: 'select-one', tagName: 'SELECT', value: '532', values: ['405', '488', '532', '633']
    })],
    ['x_pixels', makeControl('x_pixels', { min: '64', max: '4096', value: '1272' })],
    ['y_pixels', makeControl('y_pixels', { min: '64', max: '4096', value: '1024' })],
    ['focus_slider', makeControl('focus_slider', { type: 'range', min: '1', max: '5000' })],
    ['cgh_algorithm', makeControl('cgh_algorithm', {
        type: 'select-one', tagName: 'SELECT', value: 'gs', values: ['gs', 'oc']
    })],
    ['cgh_light_shape', makeControl('cgh_light_shape', {
        type: 'select-one', tagName: 'SELECT', value: 'gaussian',
        values: ['gaussian', 'flat-circle', 'flat-square']
    })],
    ['cgh_light_size', makeControl('cgh_light_size', { min: '1', max: '100' })],
    ['cgh_repetition', makeControl('cgh_repetition', { min: '1', max: '1000' })],
    ['cgh_width', makeControl('cgh_width', { min: '64', max: '4096' })],
    ['cgh_height', makeControl('cgh_height', { min: '64', max: '4096' })],
    ['cgh_gaussian_spots', makeControl('cgh_gaussian_spots', { type: 'checkbox' })],
    ['cgh_spot_radius', makeControl('cgh_spot_radius', { min: '0', max: '1000' })]
]);

const document = {
    getElementById(id) {
        if (!controls.has(id)) controls.set(id, makeControl(id));
        return controls.get(id);
    }
};
let wavelengthApplied = null;
const context = vm.createContext({
    document,
    setWavelength: value => { wavelengthApplied = value; },
    validateSpotArrayProjectState() { throw new Error('unexpected spot validation'); },
    restoreSpotArrayProjectState() { throw new Error('unexpected spot restoration'); },
    console: { warn() {} }
});
const source = fs.readFileSync('./static/js/pro_main.js', 'utf8');
const validateStart = source.indexOf('function validateProjectControls');
const validateEnd = source.indexOf('async function restoreProjectSequence', validateStart);
const historyStart = source.indexOf('function restoreHistoryParameters');
const historyEnd = source.indexOf('// ==================== 通知系统', historyStart);
assert.notEqual(validateStart, -1);
assert.notEqual(historyStart, -1);
vm.runInContext(source.slice(validateStart, validateEnd) + '\n' +
    source.slice(historyStart, historyEnd), context);

const restored = context.restoreHistoryParameters({
    version: 1,
    pattern_type: 'fresnel',
    parameters: { focal_length: 1800, wavelength: 633, width: 1024, height: 768 }
});
assert.equal(restored, true);
assert.equal(controls.get('focus_mm').value, '1800');
assert.equal(controls.get('wavelength_nm').value, '633');
assert.equal(controls.get('x_pixels').value, '1024');
assert.equal(controls.get('y_pixels').value, '768');
assert.equal(controls.get('focus_slider').value, '1800');
assert.equal(wavelengthApplied, '633');

const beforeInvalidRestore = controls.get('focus_mm').value;
assert.equal(context.restoreHistoryParameters({
    version: 1,
    pattern_type: 'fresnel',
    parameters: { focus_mm: 9000, wavelength_nm: 405, width: 2048, height: 1024 }
}), false);
assert.equal(controls.get('focus_mm').value, beforeInvalidRestore);

assert.equal(context.restoreHistoryParameters({
    version: 1,
    pattern_type: 'cgh',
    parameters: {
        algorithm: 'oc', light_shape: 'flat-square', light_size: 12,
        iterations: 40, width: 256, height: 192, gaussian_spots: true, spot_radius: 5
    }
}), true);
assert.equal(controls.get('cgh_algorithm').value, 'oc');
assert.equal(controls.get('cgh_width').value, '256');
assert.equal(controls.get('cgh_gaussian_spots').checked, true);

process.stdout.write('Passed history parameter restore and invalid-snapshot atomicity checks.\n');
