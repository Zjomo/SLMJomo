(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.readProjectImageDimensions = api.readProjectImageDimensions;
        root.projectImageDimensionsMatch = api.projectImageDimensionsMatch;
    }
})(globalThis, function() {
    const JPEG_FRAME_MARKERS = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ]);

    function readProjectImageDimensions(dataUri) {
        if (typeof dataUri !== 'string') throw new Error('Invalid image data');
        const separator = dataUri.indexOf(',');
        const mimeEnd = dataUri.indexOf(';', 5);
        if (separator < 0 || mimeEnd < 0 || mimeEnd > separator) {
            throw new Error('Invalid image data URI');
        }

        const mime = dataUri.slice(5, mimeEnd).toLowerCase();
        const encoded = dataUri.slice(separator + 1).replace(/\s/g, '');
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const ascii = (offset, length) => {
            let value = '';
            for (let index = 0; index < length; index++) {
                value += String.fromCharCode(bytes[offset + index]);
            }
            return value;
        };
        let width;
        let height;

        if (mime === 'image/png') {
            if (bytes.length < 24 || ascii(0, 8) !== '\x89PNG\r\n\x1a\n') {
                throw new Error('Invalid PNG header');
            }
            width = view.getUint32(16, false);
            height = view.getUint32(20, false);
        } else if (mime === 'image/jpeg' || mime === 'image/jpg') {
            if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
                throw new Error('Invalid JPEG header');
            }
            let offset = 2;
            while (offset + 4 <= bytes.length) {
                if (bytes[offset] !== 0xff) {
                    offset++;
                    continue;
                }
                while (bytes[offset] === 0xff) offset++;
                const marker = bytes[offset++];
                if (marker === 0xd9 || marker === 0xda) break;
                if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
                    continue;
                }
                if (offset + 2 > bytes.length) break;
                const segmentLength = view.getUint16(offset, false);
                if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
                if (JPEG_FRAME_MARKERS.has(marker)) {
                    if (segmentLength < 7) break;
                    height = view.getUint16(offset + 3, false);
                    width = view.getUint16(offset + 5, false);
                    break;
                }
                offset += segmentLength;
            }
        } else if (mime === 'image/bmp') {
            if (bytes.length < 26 || ascii(0, 2) !== 'BM') throw new Error('Invalid BMP header');
            const dibSize = view.getUint32(14, true);
            if (dibSize === 12 && bytes.length >= 26) {
                width = view.getUint16(18, true);
                height = view.getUint16(20, true);
            } else if (dibSize >= 40 && bytes.length >= 26) {
                width = view.getInt32(18, true);
                height = Math.abs(view.getInt32(22, true));
            }
        } else if (mime === 'image/gif') {
            if (bytes.length < 10 || !['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
                throw new Error('Invalid GIF header');
            }
            width = view.getUint16(6, true);
            height = view.getUint16(8, true);
        } else if (mime === 'image/webp') {
            if (bytes.length < 20 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') {
                throw new Error('Invalid WebP header');
            }
            let offset = 12;
            while (offset + 8 <= bytes.length) {
                const chunkType = ascii(offset, 4);
                const chunkLength = view.getUint32(offset + 4, true);
                const payload = offset + 8;
                if (payload + chunkLength > bytes.length) break;
                if (chunkType === 'VP8X' && chunkLength >= 10) {
                    width = 1 + bytes[payload + 4] + (bytes[payload + 5] << 8) + (bytes[payload + 6] << 16);
                    height = 1 + bytes[payload + 7] + (bytes[payload + 8] << 8) + (bytes[payload + 9] << 16);
                    break;
                }
                if (chunkType === 'VP8 ' && chunkLength >= 10 &&
                    bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a) {
                    width = view.getUint16(payload + 6, true) & 0x3fff;
                    height = view.getUint16(payload + 8, true) & 0x3fff;
                    break;
                }
                if (chunkType === 'VP8L' && chunkLength >= 5 && bytes[payload] === 0x2f) {
                    const packed = (bytes[payload + 1] | (bytes[payload + 2] << 8) |
                        (bytes[payload + 3] << 16) | (bytes[payload + 4] << 24)) >>> 0;
                    width = (packed & 0x3fff) + 1;
                    height = ((packed >>> 14) & 0x3fff) + 1;
                    break;
                }
                offset = payload + chunkLength + (chunkLength & 1);
            }
        } else if (mime === 'image/tiff') {
            if (bytes.length < 8) throw new Error('Invalid TIFF header');
            const byteOrder = ascii(0, 2);
            const littleEndian = byteOrder === 'II';
            if (!littleEndian && byteOrder !== 'MM') throw new Error('Invalid TIFF byte order');
            if (view.getUint16(2, littleEndian) !== 42) throw new Error('Unsupported TIFF header');
            const ifdOffset = view.getUint32(4, littleEndian);
            if (ifdOffset + 2 > bytes.length) throw new Error('Invalid TIFF directory');
            const entryCount = view.getUint16(ifdOffset, littleEndian);
            const entriesStart = ifdOffset + 2;
            if (entriesStart + entryCount * 12 > bytes.length) throw new Error('Invalid TIFF directory');
            for (let index = 0; index < entryCount; index++) {
                const entry = entriesStart + index * 12;
                const tag = view.getUint16(entry, littleEndian);
                if (tag !== 256 && tag !== 257) continue;
                const type = view.getUint16(entry + 2, littleEndian);
                const count = view.getUint32(entry + 4, littleEndian);
                if (count !== 1) continue;
                let value;
                if (type === 3) {
                    value = view.getUint16(entry + 8, littleEndian);
                } else if (type === 4) {
                    value = view.getUint32(entry + 8, littleEndian);
                }
                if (tag === 256) width = value;
                if (tag === 257) height = value;
            }
        } else {
            throw new Error('Unsupported image format');
        }

        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
            throw new Error('Image dimensions are missing or invalid');
        }
        return { width, height };
    }

    function projectImageDimensionsMatch(dataUri, headerDimensions, decodedDimensions) {
        if (decodedDimensions.width === headerDimensions.width &&
            decodedDimensions.height === headerDimensions.height) return true;
        const isJpeg = /^data:image\/(?:jpe?g);base64,/i.test(dataUri);
        return isJpeg && decodedDimensions.width === headerDimensions.height &&
            decodedDimensions.height === headerDimensions.width;
    }

    return { readProjectImageDimensions, projectImageDimensionsMatch };
});
