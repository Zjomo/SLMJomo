const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {}, Float32Array, Uint8Array, Int32Array, Number, Math, Array, Error };
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/js/slam_spot_vision.js', 'utf8'), context);
const { estimateBrightSpot } = context.window.SLAMSpotVision;

function image(width, height, value = 28) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const gradient = Math.round(18 * x / Math.max(1, width - 1));
            const noise = ((x * 17 + y * 31) % 5) - 2;
            const gray = Math.max(0, Math.min(255, value + gradient + noise));
            data[index] = data[index + 1] = data[index + 2] = gray;
            data[index + 3] = 255;
        }
    }
    return { width, height, data };
}

function addGaussian(target, centerX, centerY, amplitude = 190, sigma = 2.8) {
    for (let y = 0; y < target.height; y++) {
        for (let x = 0; x < target.width; x++) {
            const radius2 = (x - centerX) ** 2 + (y - centerY) ** 2;
            const value = amplitude * Math.exp(-radius2 / (2 * sigma * sigma));
            const index = (y * target.width + x) * 4;
            const gray = Math.min(255, target.data[index] + value);
            target.data[index] = target.data[index + 1] = target.data[index + 2] = gray;
        }
    }
}

const noisy = image(80, 80);
addGaussian(noisy, 42.4, 37.7);
const hotPixel = (38 * noisy.width + 40) * 4;
noisy.data[hotPixel] = noisy.data[hotPixel + 1] = noisy.data[hotPixel + 2] = 255;
const measured = estimateBrightSpot(noisy, 40, 38, 16);
assert.ok(Math.abs(measured.x_px - 42.4) < 0.7, `x centroid: ${measured.x_px}`);
assert.ok(Math.abs(measured.y_px - 37.7) < 0.7, `y centroid: ${measured.y_px}`);
assert.ok(measured.confidence > 0.5);

const dark = image(80, 80);
assert.throws(() => estimateBrightSpot(dark, 40, 40, 16), /没有足够明显的亮斑|亮点过小/);

const singlePixel = image(80, 80);
const isolated = (40 * singlePixel.width + 40) * 4;
singlePixel.data[isolated] = singlePixel.data[isolated + 1] = singlePixel.data[isolated + 2] = 255;
assert.throws(() => estimateBrightSpot(singlePixel, 40, 40, 16), /亮点过小/);

const broad = image(80, 80);
for (let y = 24; y <= 56; y++) {
    for (let x = 24; x <= 56; x++) {
        if (Math.hypot(x - 40, y - 40) > 16) continue;
        const index = (y * broad.width + x) * 4;
        broad.data[index] = broad.data[index + 1] = broad.data[index + 2] = 240;
    }
}
assert.throws(() => estimateBrightSpot(broad, 40, 40, 16), /超出局部搜索范围/);
assert.throws(() => estimateBrightSpot(noisy, 2, 2, 16), /图像边缘/);

process.stdout.write('SLAM spot vision: 5 checks passed\n');
