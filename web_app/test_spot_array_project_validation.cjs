const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map([
    ['three_spot_algorithm', { value: 'uniform_grating', options: [
        { value: 'uniform_grating' }, { value: 'gaussian_wgs' }, { value: 'dammann' }
    ] }],
    ['three_spot_focus', { value: '1000' }],
    ['three_spot_wavelength', { value: '532' }],
    ['three_spot_pixel_size', { value: '12.5' }],
    ['three_spot_width', { value: '1272' }],
    ['three_spot_height', { value: '1024' }],
    ['three_spot_beam_diameter', { value: '10' }],
    ['three_spot_radius', { value: '' }]
]);
const context = vm.createContext({
    document: {
        addEventListener() {},
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, { value: '' });
            return elements.get(id);
        }
    }
});
vm.runInContext(fs.readFileSync('./static/js/spot_array.js', 'utf8'), context);

const originalSpotState = JSON.stringify(vm.runInContext('SpotArrayState', context));
const originalFocus = elements.get('three_spot_focus').value;
const projectControls = {
    three_spot_focus: '500',
    three_spot_width: '512',
    three_spot_height: '512'
};
const validProjectSpots = {
    customized: true,
    legacyAlgorithm: 'uniform_grating',
    spots: [
        { x_mm: -0.5, y_mm: 0, weight: 1 },
        { x_mm: 0.5, y_mm: 0, weight: 0.8 }
    ]
};

const validated = vm.runInContext(
    `validateSpotArrayProjectState(${JSON.stringify(validProjectSpots)}, ${JSON.stringify(projectControls)})`,
    context
);
assert.equal(validated.reset, false);
assert.equal(validated.spots.length, 2);
assert.equal(elements.get('three_spot_focus').value, originalFocus);
const importedLegacyAlgorithm = vm.runInContext(
    `validateSpotArrayProjectState(null, { three_spot_algorithm: 'dammann' })`, context
);
assert.equal(importedLegacyAlgorithm.legacyAlgorithm, 'dammann');

const outsideCandidateBounds = structuredClone(validProjectSpots);
outsideCandidateBounds.spots[0].x_mm = 11;
assert.throws(() => vm.runInContext(
    `validateSpotArrayProjectState(${JSON.stringify(outsideCandidateBounds)}, ${JSON.stringify(projectControls)})`,
    context
), /光斑参数无效/);

const radiusLimitedProject = structuredClone(validProjectSpots);
radiusLimitedProject.spots[0].x_mm = 13;
radiusLimitedProject.spots[1].x_mm = -13;
assert.throws(() => vm.runInContext(
    `validateSpotArrayProjectState(${JSON.stringify(radiusLimitedProject)}, ${JSON.stringify({
        three_spot_width: '1024', three_spot_height: '1024', three_spot_radius: '4'
    })})`,
    context
), /光斑参数无效/);

assert.equal(elements.get('three_spot_algorithm').value, 'uniform_grating');
assert.equal(elements.get('three_spot_focus').value, originalFocus);
assert.equal(JSON.stringify(vm.runInContext('SpotArrayState', context)), originalSpotState);

process.stdout.write('Passed 5 atomic spot-array project validation checks.\n');
