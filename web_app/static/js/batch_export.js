/**
 * 批量参数扫描（菲涅尔多点聚焦 → ZIP）
 * =====================================
 * - 光斑模板行自动跟随当前光斑阵列实时更新：
 *     · 等间距模式：n 行，X = 系数×变量（系数 = i-(n-1)/2），扫描"间距"
 *     · 自定义阵列：m 行，X/Y = 编辑器坐标×变量（缩放系数 s，1→0 即向中心收拢）
 *   取消勾选"跟随当前阵列"后模板行可手动编辑，不再被覆盖。
 * - POST /api/generate/batch_spots，blob 下载 ZIP。
 * 依赖 pro_main.js 的 showNotification()。
 */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    function notify(msg, type) {
        if (typeof showNotification === 'function') showNotification(msg, type || 'info');
        else console.log(`[batch] ${msg}`);
    }

    function num(id, fallback) {
        const v = parseFloat($(id) && $(id).value);
        return Number.isFinite(v) ? v : fallback;
    }

    function fmt(v) {
        // 紧凑数字：去掉多余的 0 与尾随点
        const s = (Math.round(v * 10000) / 10000).toString();
        return s === '-0' ? '0' : s;
    }

    // ---------- 当前光斑阵列状态 ----------
    let lastSignature = null;

    function isCustomMode() {
        return typeof isSpotArrayCustomized === 'function' && isSpotArrayCustomized()
            && typeof SpotArrayState !== 'undefined'
            && Array.isArray(SpotArrayState.spots)
            && SpotArrayState.spots.length > 0;
    }

    function currentSignature() {
        if (isCustomMode()) {
            const pts = SpotArrayState.spots.map(s =>
                `${Number(s.x_mm).toFixed(4)},${Number(s.y_mm).toFixed(4)},` +
                `${Number(s.weight).toFixed(3)}`);
            return `custom:${pts.join('|')}`;
        }
        const n = parseInt($('three_spot_count') && $('three_spot_count').value, 10) || 3;
        return `uniform:${n}`;
    }

    /**
     * 依据当前光斑阵列生成自动模板。
     * 返回 {mode, rows:[{x,y,w}]}。
     */
    function autoTemplate() {
        const varName = ($('batch_var').value || 'd').trim() || 'd';
        if (isCustomMode()) {
            // 自定义阵列：编辑器坐标 × 缩放系数（s=1 原形，s=0 收拢到中心）
            return {
                mode: 'custom',
                rows: SpotArrayState.spots.map(sp => ({
                    x: `${fmt(Number(sp.x_mm))}*${varName}`,
                    y: `${fmt(Number(sp.y_mm))}*${varName}`,
                    w: fmt(Number(sp.weight))
                }))
            };
        }
        // 等间距模式：n 个水平排列点，变量 = 相邻点间距
        const n = parseInt($('three_spot_count') && $('three_spot_count').value, 10) || 3;
        return {
            mode: 'uniform',
            rows: Array.from({ length: n }, (_, i) => {
                const coef = i - (n - 1) / 2;
                const coefExpr = coef === 0 ? '0' : `${fmt(coef)}*${varName}`;
                return { x: coefExpr, y: '0', w: '1' };
            })
        };
    }

    // ---------- 模板行渲染 ----------
    function renderTemplateRows(rows) {
        const container = $('batch_template_rows');
        if (!container) return;
        container.replaceChildren(...rows.map((row, i) => {
            const div = document.createElement('div');
            div.className = 'batch-scan-row batch-tpl-row';
            const label = document.createElement('span');
            label.textContent = `Q${i + 1}`;
            div.appendChild(label);
            [['x', row.x], ['y', row.y], ['w', row.w]].forEach(([suffix, value]) => {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'param-input batch-tpl-input';
                input.dataset.slot = suffix;
                input.dataset.index = String(i);
                input.value = value;
                div.appendChild(input);
            });
            return div;
        }));
    }

    /**
     * 由模块当前状态刷新模板行（签名变化时覆盖并切换默认扫描范围）。
     * window.refreshBatchTemplate 由 spot_array.js / pro_main.js 在光斑变化时调用。
     */
    function refreshBatchTemplate(force) {
        if (!$('batch_scan_panel')) return;
        const signature = currentSignature();
        if (!force && signature === lastSignature) return;
        const follow = !$('batch_follow') || $('batch_follow').checked;
        const prevMode = lastSignature ? lastSignature.split(':')[0] : null;
        lastSignature = signature;
        const auto = autoTemplate();
        if (!follow) return; // 手动锁定：仅记录签名，不覆盖行
        renderTemplateRows(auto.rows);
        // 模式切换时重置扫描范围为该模式的默认语义
        if (prevMode !== auto.mode) {
            if (auto.mode === 'custom') {
                $('batch_start').value = '1';  // 缩放系数：1 = 原形
                $('batch_stop').value = '0';   // 0 = 收拢到中心
            } else if (prevMode !== null) {
                $('batch_start').value = '2.0'; // 间距扫描默认
                $('batch_stop').value = '0.0';
            }
        }
        updatePreview();
    }

    function collectTemplate() {
        const container = $('batch_template_rows');
        if (!container) return [];
        const rows = [];
        container.querySelectorAll('.batch-scan-row').forEach(div => {
            const get = suffix => {
                const input = div.querySelector(`input[data-slot="${suffix}"]`);
                return input ? input.value.trim() || '0' : '0';
            };
            rows.push({ x_mm: get('x'), y_mm: get('y'), weight: get('w') });
        });
        return rows.length ? rows : [{ x_mm: 0, y_mm: 0, weight: 1 }];
    }

    // ---------- 预览与生成 ----------
    function frameCount() {
        const start = num('batch_start', 0);
        const stop = num('batch_stop', 0);
        const step = Math.abs(num('batch_step', 0.1)) || 0.1;
        const span = Math.abs(stop - start);
        if (span < 1e-12) return 1;
        return Math.min(1000, Math.floor(span / step + 1e-9) + 1);
    }

    function updatePreview() {
        const el = $('batch_status');
        if (!el) return;
        const varName = ($('batch_var').value || 'd').trim() || 'd';
        const mode = isCustomMode() ? `阵列缩放 ${varName}` : `间距 ${varName}`;
        const rows = $('batch_template_rows')
            ? $('batch_template_rows').querySelectorAll('.batch-scan-row').length : 0;
        el.textContent = `预览：${mode} = ${num('batch_start', 0)} → ` +
            `${num('batch_stop', 0)}，${rows} 点 × 共 ${frameCount()} 帧`;
    }

    async function generateBatchSpots() {
        if (!$('batch_scan_panel')) return;
        const algorithmEl = $('three_spot_algorithm');
        const payload = {
            base_params: {
                width: parseInt($('three_spot_width').value, 10) || 1272,
                height: parseInt($('three_spot_height').value, 10) || 1024,
                focal_length: parseFloat($('three_spot_focus').value) || 1000,
                wavelength: parseFloat($('three_spot_wavelength').value) || 532,
                pixel_size_um: parseFloat($('three_spot_pixel_size').value) || 12.5,
                algorithm: algorithmEl ? algorithmEl.value : 'gaussian_wgs',
                incident_beam_diameter_mm:
                    parseFloat($('three_spot_beam_diameter').value) || 10.0,
                iterations: parseInt($('three_spot_iterations').value, 10) || 30,
                phase_direction:
                    ($('three_spot_phase_direction') || {}).value || 'standard'
            },
            spots_template: collectTemplate(),
            variable: {
                name: ($('batch_var').value || 'd').trim(),
                start: num('batch_start', 0),
                stop: num('batch_stop', 0),
                step: num('batch_step', 0.1)
            },
            frame_duration_ms: parseInt($('batch_frame_ms').value, 10) || 100,
            skip_errors: true
        };

        const frames = frameCount();
        const estSeconds = frames * 3;
        const status = $('batch_status');
        const btn = $('batch_scan_panel').querySelector('button');
        btn.disabled = true;
        if (status) status.textContent =
            `批量生成中：${frames} 帧，约需 ${estSeconds}s~${Math.round(estSeconds * 1.6)}s，请稍候…`;

        try {
            const resp = await fetch('/api/generate/batch_spots', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!resp.ok) {
                let msg = `批量生成失败 (${resp.status})`;
                try {
                    const body = await resp.json();
                    if (body && body.error) msg = `批量生成失败: ${body.error}`;
                } catch (e) { /* ignore */ }
                throw new Error(msg);
            }
            const blob = await resp.blob();
            const disposition = resp.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/);
            const filename = match
                ? decodeURIComponent(match[1])
                : `batch_spots_${Date.now()}.zip`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 3000);
            notify(`批量生成完成，已下载 ${filename}（${frames} 帧）`, 'success');
            updatePreview();
        } catch (e) {
            notify(e.message, 'error');
            if (status) status.textContent = `生成失败：${e.message}`;
        } finally {
            btn.disabled = false;
        }
    }

    // ---------- 初始化 ----------
    function hookSpotUpdates() {
        // 零侵入挂接：光斑阵列/数量变化的汇聚函数（增删、拖动、重置、count 调整）
        ['updateSpotArraySelection', 'renderSpotArrayEditor',
            'toggleThreeSpotOptimization'].forEach(fnName => {
            const original = window[fnName];
            if (typeof original !== 'function' || original.__batchHooked) return;
            const wrapped = function (...args) {
                const result = original.apply(this, args);
                refreshBatchTemplate();
                return result;
            };
            wrapped.__batchHooked = true;
            window[fnName] = wrapped;
        });
    }

    function initBatchScan() {
        if (!$('batch_scan_panel')) return;
        const varEl = $('batch_var');
        if (varEl) varEl.addEventListener('input', () => refreshBatchTemplate(true));
        ['batch_start', 'batch_stop', 'batch_step']
            .forEach(id => {
                const el = $(id);
                if (el) el.addEventListener('input', updatePreview);
            });
        const follow = $('batch_follow');
        if (follow) follow.addEventListener('change', () => refreshBatchTemplate(true));
        hookSpotUpdates();
        refreshBatchTemplate(true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initBatchScan);
    } else {
        initBatchScan();
    }

    window.generateBatchSpots = generateBatchSpots;
    window.refreshBatchTemplate = refreshBatchTemplate;
})();
