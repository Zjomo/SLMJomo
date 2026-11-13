(function () {
    'use strict';

    function median(values) {
        if (!values.length) return 0;
        values.sort((left, right) => left - right);
        const middle = Math.floor(values.length / 2);
        return values.length % 2
            ? values[middle]
            : (values[middle - 1] + values[middle]) / 2;
    }

    function estimateBrightSpot(imageData, seedX, seedY, radiusPx = 16) {
        if (!imageData || !Number.isInteger(imageData.width) ||
                !Number.isInteger(imageData.height) || !imageData.data) {
            throw new Error('光斑检测图像数据无效');
        }
        if (!Number.isFinite(seedX) || !Number.isFinite(seedY) ||
                !Number.isInteger(radiusPx) || radiusPx < 3) {
            throw new Error('光斑中心点或搜索半径无效');
        }
        const left = Math.floor(seedX) - radiusPx;
        const top = Math.floor(seedY) - radiusPx;
        const width = radiusPx * 2 + 1;
        const height = radiusPx * 2 + 1;
        if (left < 0 || top < 0 || left + width > imageData.width ||
                top + height > imageData.height) {
            throw new Error('点选位置太靠近图像边缘，请移到光斑附近重新点选');
        }

        const count = width * height;
        const gray = new Float32Array(count);
        const border = [];
        let peak = -1;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const sourceIndex = ((top + y) * imageData.width + left + x) * 4;
                const value = 0.2126 * imageData.data[sourceIndex] +
                    0.7152 * imageData.data[sourceIndex + 1] +
                    0.0722 * imageData.data[sourceIndex + 2];
                const index = y * width + x;
                gray[index] = value;
                if (value > peak) {
                    peak = value;
                }
                if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) {
                    border.push(value);
                }
            }
        }

        const background = median(border);
        const deviations = border.map(value => Math.abs(value - background));
        const noiseSigma = Math.max(1, 1.4826 * median(deviations));
        const threshold = background + Math.max(8, 4 * noiseSigma);
        if (peak <= threshold) {
            throw new Error('点选区域内没有足够明显的亮斑');
        }

        const visited = new Uint8Array(count);
        const queue = new Int32Array(count);
        const candidates = [];
        let hasEdgeCandidate = false;
        for (let start = 0; start < count; start++) {
            if (visited[start] || gray[start] <= threshold) continue;
            let head = 0;
            let tail = 0;
            queue[tail++] = start;
            visited[start] = 1;
            let area = 0;
            let touchesSearchEdge = false;
            let componentPeak = -1;
            while (head < tail) {
                const index = queue[head++];
                const x = index % width;
                const y = Math.floor(index / width);
                area++;
                componentPeak = Math.max(componentPeak, gray[index]);
                if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
                    touchesSearchEdge = true;
                }
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        const neighbor = ny * width + nx;
                        if (!visited[neighbor] && gray[neighbor] > threshold) {
                            visited[neighbor] = 1;
                            queue[tail++] = neighbor;
                        }
                    }
                }
            }
            if (touchesSearchEdge && area >= 3) hasEdgeCandidate = true;
            if (touchesSearchEdge || area > count * 0.6 || area < 3) continue;
            let weightSum = 0;
            let weightedX = 0;
            let weightedY = 0;
            const weightCap = Math.max(1, (componentPeak - background) * 0.7);
            for (let index = 0; index < tail; index++) {
                const pixel = queue[index];
                const weight = Math.min(weightCap, Math.max(0, gray[pixel] - background));
                weightSum += weight;
                weightedX += (left + pixel % width) * weight;
                weightedY += (top + Math.floor(pixel / width)) * weight;
            }
            if (weightSum <= 0) continue;
            const xPx = weightedX / weightSum;
            const yPx = weightedY / weightSum;
            candidates.push({
                x_px: xPx,
                y_px: yPx,
                area_px: area,
                peak: componentPeak,
                weightSum,
                distance: Math.hypot(xPx - seedX, yPx - seedY)
            });
        }

        if (!candidates.length) {
            if (hasEdgeCandidate) throw new Error('亮区超出局部搜索范围，请增大半径或重新点选');
            throw new Error('检测到的亮点过小，可能是噪声');
        }
        candidates.sort((a, b) => a.distance - b.distance || b.weightSum - a.weightSum);
        const candidate = candidates[0];
        if (candidate.distance > radiusPx * 0.8) {
            throw new Error('附近未找到与点选位置对应的亮斑');
        }
        return {
            x_px: candidate.x_px,
            y_px: candidate.y_px,
            area_px: candidate.area_px,
            peak: candidate.peak,
            background,
            contrast: candidate.peak - background,
            confidence: Math.min(1, (candidate.peak - background) / (6 * noiseSigma))
        };
    }

    window.SLAMSpotVision = { estimateBrightSpot };
})();
