const assert = require('node:assert/strict');
const { readProjectImageDimensions, projectImageDimensionsMatch } =
    require('./static/js/project_image_utils.js');

function toDataUri(mime, bytes) {
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function makePng(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

function makeJpeg(width, height) {
    const bytes = Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
        height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x11, 0x00,
        0xff, 0xd9
    ]);
    return bytes;
}

function makeBmp(width, height) {
    const bytes = Buffer.alloc(54);
    bytes.write('BM', 0, 'ascii');
    bytes.writeUInt32LE(40, 14);
    bytes.writeInt32LE(width, 18);
    bytes.writeInt32LE(height, 22);
    return bytes;
}

function makeGif(width, height) {
    const bytes = Buffer.alloc(10);
    bytes.write('GIF89a', 0, 'ascii');
    bytes.writeUInt16LE(width, 6);
    bytes.writeUInt16LE(height, 8);
    return bytes;
}

function makeWebp(width, height) {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WEBP', 8, 'ascii');
    bytes.write('VP8X', 12, 'ascii');
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
    return bytes;
}

function makeTiff(width, height, littleEndian, fieldType = 4) {
    const bytes = Buffer.alloc(38);
    const endian = littleEndian ? 'LE' : 'BE';
    bytes.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
    bytes[`writeUInt16${endian}`](42, 2);
    bytes[`writeUInt32${endian}`](8, 4);
    bytes[`writeUInt16${endian}`](2, 8);
    for (const [index, tag, value] of [[0, 256, width], [1, 257, height]]) {
        const offset = 10 + index * 12;
        bytes[`writeUInt16${endian}`](tag, offset);
        bytes[`writeUInt16${endian}`](fieldType, offset + 2);
        bytes[`writeUInt32${endian}`](1, offset + 4);
        if (fieldType === 3) bytes[`writeUInt16${endian}`](value, offset + 8);
        else bytes[`writeUInt32${endian}`](value, offset + 8);
    }
    return bytes;
}

const cases = [
    ['PNG', 'image/png', makePng(640, 480)],
    ['JPEG', 'image/jpeg', makeJpeg(640, 480)],
    ['BMP', 'image/bmp', makeBmp(640, 480)],
    ['GIF', 'image/gif', makeGif(640, 480)],
    ['WebP', 'image/webp', makeWebp(640, 480)],
    ['little-endian TIFF', 'image/tiff', makeTiff(640, 480, true)],
    ['big-endian TIFF', 'image/tiff', makeTiff(640, 480, false)],
    ['little-endian TIFF SHORT', 'image/tiff', makeTiff(640, 480, true, 3)],
    ['big-endian TIFF SHORT', 'image/tiff', makeTiff(640, 480, false, 3)]
];

for (const [label, mime, bytes] of cases) {
    assert.deepEqual(readProjectImageDimensions(toDataUri(mime, bytes)), { width: 640, height: 480 }, label);
}

assert.throws(() => readProjectImageDimensions('not a data uri'), /data/i);
assert.throws(() => readProjectImageDimensions(toDataUri('image/png', Buffer.alloc(24))), /PNG/i);
assert.throws(() => readProjectImageDimensions(toDataUri('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))), /dimensions/i);
assert.throws(() => readProjectImageDimensions(toDataUri('image/gif', makeGif(0, 480))), /dimensions/i);
assert.throws(() => readProjectImageDimensions(toDataUri('image/tiff', Buffer.alloc(8))), /TIFF/i);
assert.throws(() => readProjectImageDimensions(toDataUri('image/avif', Buffer.alloc(16))), /Unsupported/i);

const jpegUri = toDataUri('image/jpeg', makeJpeg(640, 480));
assert.equal(projectImageDimensionsMatch(jpegUri, { width: 640, height: 480 }, { width: 480, height: 640 }), true);
assert.equal(projectImageDimensionsMatch(toDataUri('image/png', makePng(640, 480)),
    { width: 640, height: 480 }, { width: 480, height: 640 }), false);
assert.equal(projectImageDimensionsMatch(jpegUri, { width: 640, height: 480 }, { width: 320, height: 240 }), false);

process.stdout.write(`Passed ${cases.length + 9} image header checks.\n`);
