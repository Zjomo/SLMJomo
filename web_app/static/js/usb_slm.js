/**
 * USB_SLMControl 前端模块
 * ========================
 * 对应 Hamamatsu USB_SLMControl.exe 功能还原：
 * 设备连接 / 状态监控 / 帧存储器 / SD 卡 / 序列播放。
 * 依赖 pro_main.js 中的 showNotification() 与 AppState.currentImageData。
 */
(function () {
    'use strict';

    const API = '/api/usb_slm';
    let statusTimer = null;

    // ---------- 工具 ----------
    function $(id) { return document.getElementById(id); }

    async function api(path, options) {
        const resp = await fetch(API + path, options);
        let payload = {};
        try { payload = await resp.json(); } catch (e) { /* ignore */ }
        if (!resp.ok || payload.success === false) {
            throw new Error(payload.error || `请求失败 (${resp.status})`);
        }
        return payload;
    }

    function jsonPost(path, body) {
        return api(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
    }

    function notify(msg, type) {
        if (typeof showNotification === 'function') showNotification(msg, type || 'info');
        else console.log(`[USB_SLMControl] ${msg}`);
    }

    function getBid() {
        const sel = $('usbslm_bid');
        return sel && sel.value !== '' ? Number(sel.value) : undefined;
    }

    function getFmemSlot() {
        const v = Number($('usbslm_fmem_slot').value);
        if (!Number.isInteger(v) || v < 0 || v > 818) throw new Error('FMem 槽位必须在 0~818 之间');
        return v;
    }

    function getSdSlot() {
        const v = Number($('usbslm_sd_slot').value);
        if (!Number.isInteger(v) || v < 0 || v > 5658) throw new Error('SD 槽位必须在 0~5658 之间');
        return v;
    }

    function getCurrentImageB64() {
        const img = (typeof AppState !== 'undefined') ? AppState.currentImageData : null;
        if (!img || !img.image) throw new Error('请先在主预览中生成相位图');
        return img.image; // dataURL
    }

    // ---------- 状态渲染 ----------
    function renderStatus(st) {
        const conn = $('usbslm_conn_text');
        if (!conn) return;
        conn.textContent = st.connected
            ? (st.driver === 'real' ? '已连接（真机·64位）'
               : st.driver === 'bridge32' ? '已连接（真机·32位桥）'
               : '已连接（模拟）')
            : '未连接';
        // bID 下拉
        const bidSel = $('usbslm_bid');
        const prev = bidSel.value;
        bidSel.innerHTML = '';
        (st.devices || []).forEach(b => {
            const opt = document.createElement('option');
            opt.value = String(b);
            opt.textContent = `bID ${b}`;
            bidSel.appendChild(opt);
        });
        if (st.current_bid !== null && st.current_bid !== undefined) {
            bidSel.value = String(st.current_bid);
        } else if (prev && [...bidSel.options].some(o => o.value === prev)) {
            bidSel.value = prev;
        }
    }

    function renderDeviceInfo(info) {
        if (!info) return;
        $('usbslm_serial').textContent = info.head_serial || '--';
        $('usbslm_head_temp').textContent = `${info.head_temp.toFixed(1)} ℃`;
        $('usbslm_cb_temp').textContent = `${info.cb_temp.toFixed(1)} ℃`;
        $('usbslm_led').textContent = info.led_status ? `0x${info.led_status.toString(16).toUpperCase()}` : '0x0（熄灭）';
        $('usbslm_io').textContent = `0x${info.io_status.toString(16).toUpperCase()}`;
        if (typeof info.mode === 'number') $('usbslm_mode').value = String(info.mode);
    }

    function renderSequence(st) {
        if (!st) return;
        $('usbslm_seq_state').textContent = st.playing ? '播放中' : '待机';
        $('usbslm_seq_slot').textContent = (st.playing && st.current_slot !== null)
            ? String(st.current_slot) : '--';
        $('usbslm_seq_frames').textContent = String(st.frame_count || 0);
        $('usbslm_seq_iters').textContent = String(st.iterations || 0);
    }

    async function refreshUsbSlmStatus() {
        try {
            const st = await api('/status');
            renderStatus(st);
            renderSequence(st.sequence);
            if (st.connected) {
                try {
                    renderDeviceInfo(await api(`/device-info${getBid() !== undefined ? '?bid=' + getBid() : ''}`));
                } catch (e) { /* 设备信息刷新失败不阻塞 */ }
            }
        } catch (e) {
            console.error(e);
        }
    }
    window.refreshUsbSlmStatus = refreshUsbSlmStatus;

    // ---------- 设备连接 ----------
    async function usbslmConnect() {
        try {
            const st = await jsonPost('/connect', { driver: $('usbslm_driver').value });
            notify(st.message || '已连接', 'success');
            renderStatus(st);
            await refreshUsbSlmStatus();
            startPolling();
        } catch (e) {
            notify(`连接失败: ${e.message}`, 'error');
        }
    }

    async function usbslmDisconnect() {
        try {
            stopPolling();
            const st = await jsonPost('/disconnect', {});
            notify(st.message || '已断开', 'info');
            renderStatus(st);
        } catch (e) {
            notify(`断开失败: ${e.message}`, 'error');
        }
    }

    async function usbslmReboot() {
        if (!window.confirm('确认重启控制器？USB 通信将中断，需要重新连接。')) return;
        try {
            stopPolling();
            const st = await jsonPost('/reboot', { bid: getBid() });
            notify(st.message || '重启指令已发送', 'info');
            renderStatus(st);
        } catch (e) {
            notify(`重启失败: ${e.message}`, 'error');
        }
    }

    async function usbslmSetMode(mode) {
        try {
            const r = await jsonPost('/mode', { mode: Number(mode), bid: getBid() });
            notify(`模式已设为 ${mode}（${r.note || ''}）`, 'success');
        } catch (e) {
            notify(`模式设置失败: ${e.message}`, 'error');
        }
    }

    function startPolling() {
        stopPolling();
        statusTimer = setInterval(async () => {
            try {
                const st = await api('/sequence/state');
                renderSequence(st);
                if (st.playing) {
                    $('usbslm_seq_slot').textContent = String(st.current_slot ?? '--');
                }
            } catch (e) { /* ignore */ }
        }, 200);
    }

    function stopPolling() {
        if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    }

    // ---------- 帧存储器 ----------
    async function usbslmWriteCurrentToFmem() {
        try {
            const slot = getFmemSlot();
            const r = await jsonPost('/fmem/write', { slot, image_b64: getCurrentImageB64(), bid: getBid() });
            notify(r.message || '写入成功', 'success');
            await usbslmReadFmem();
        } catch (e) {
            notify(`写入失败: ${e.message}`, 'error');
        }
    }

    async function usbslmUploadBmpToFmem(input) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        try {
            const slot = getFmemSlot();
            const fd = new FormData();
            fd.append('file', file);
            fd.append('slot', String(slot));
            const bid = getBid();
            if (bid !== undefined) fd.append('bid', String(bid));
            const r = await api('/fmem/write-bmp', { method: 'POST', body: fd });
            notify(r.message || 'BMP 写入成功', 'success');
            await usbslmReadFmem();
        } catch (e) {
            notify(`BMP 写入失败: ${e.message}`, 'error');
        }
    }

    async function usbslmDisplaySlot() {
        try {
            const slot = getFmemSlot();
            const r = await jsonPost('/display', { slot, bid: getBid() });
            notify(r.message || '已切换显示', 'success');
            await usbslmReadbackDisplay();
        } catch (e) {
            notify(`显示失败: ${e.message}`, 'error');
        }
    }

    async function usbslmReadFmem() {
        try {
            const slot = getFmemSlot();
            const r = await api(`/fmem/read?slot=${slot}${getBid() !== undefined ? '&bid=' + getBid() : ''}`);
            $('usbslm_fmem_preview').src = r.image;
        } catch (e) {
            notify(`读取槽位失败: ${e.message}`, 'error');
        }
    }

    async function usbslmReadbackDisplay() {
        try {
            const r = await api(`/display/readback${getBid() !== undefined ? '?bid=' + getBid() : ''}`);
            $('usbslm_disp_preview').src = r.image;
        } catch (e) {
            notify(`读回失败: ${e.message}`, 'error');
        }
    }

    // ---------- SD 卡 ----------
    async function usbslmWriteCurrentToSd() {
        try {
            const slot = getSdSlot();
            const r = await jsonPost('/sd/write', { slot, image_b64: getCurrentImageB64(), bid: getBid() });
            notify(r.message || 'SD 写入成功', 'success');
        } catch (e) {
            notify(`SD 写入失败: ${e.message}`, 'error');
        }
    }

    async function usbslmReadSd() {
        try {
            const slot = getSdSlot();
            const r = await api(`/sd/read?slot=${slot}${getBid() !== undefined ? '&bid=' + getBid() : ''}`);
            $('usbslm_sd_preview').src = r.image;
        } catch (e) {
            notify(`SD 读取失败: ${e.message}`, 'error');
        }
    }

    async function usbslmUploadSdToFmem() {
        try {
            const sdSlot = getSdSlot();
            const fmem = Number($('usbslm_sd_target_fmem').value);
            if (!Number.isInteger(fmem) || fmem < 0 || fmem > 818) {
                throw new Error('目标 FMem 槽位必须在 0~818 之间');
            }
            const r = await jsonPost('/sd/upload', { sd_slot: sdSlot, fmem_slot: fmem, bid: getBid() });
            notify(r.message || '上传成功', 'success');
            $('usbslm_fmem_slot').value = String(fmem);
            await usbslmReadFmem();
        } catch (e) {
            notify(`上传失败: ${e.message}`, 'error');
        }
    }

    // ---------- 序列播放 ----------
    function parseCsvText(text) {
        const steps = [];
        for (const line of text.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) continue;
            const parts = t.split(',');
            if (parts.length < 2) continue;
            if (parts[0].replace(/^\uFEFF/, '').toLowerCase().startsWith('slot')) continue;
            const slot = Number(parts[0]);
            const dur = Number(parts[1]);
            if (!Number.isInteger(slot) || slot < 0 || slot > 818 || !Number.isFinite(dur) || dur < 1) {
                throw new Error(`序列行非法: "${t}"（需要 槽位(0~818),毫秒(>=1)）`);
            }
            steps.push({ slot, duration_ms: Math.round(dur) });
        }
        if (!steps.length) throw new Error('序列内容为空');
        return steps;
    }

    async function usbslmStartSequence() {
        try {
            const steps = parseCsvText($('usbslm_csv').value);
            const r = await jsonPost('/sequence/start', {
                steps,
                loop: $('usbslm_loop').checked,
                bid: getBid()
            });
            notify(r.message || '序列播放开始', 'success');
            renderSequence(r);
            startPolling();
        } catch (e) {
            notify(`播放失败: ${e.message}`, 'error');
        }
    }

    async function usbslmStopSequence() {
        try {
            stopPolling();
            const r = await jsonPost('/sequence/stop', {});
            notify(r.message || '已停止', 'info');
            renderSequence(r);
        } catch (e) {
            notify(`停止失败: ${e.message}`, 'error');
        }
    }

    async function usbslmLoadCsvFile(input) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        try {
            $('usbslm_csv').value = await file.text();
            notify(`已加载 ${file.name}`, 'success');
        } catch (e) {
            notify(`CSV 加载失败: ${e.message}`, 'error');
        }
    }

    // ---------- 初始化 ----------
    function initUsbSlm() {
        if (!$('usbslm_driver')) return; // 页面无该模块
        refreshUsbSlmStatus();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUsbSlm);
    } else {
        initUsbSlm();
    }

    // 暴露给 onclick
    Object.assign(window, {
        usbslmConnect, usbslmDisconnect, usbslmReboot, usbslmSetMode,
        usbslmWriteCurrentToFmem, usbslmUploadBmpToFmem, usbslmDisplaySlot,
        usbslmReadFmem, usbslmReadbackDisplay,
        usbslmWriteCurrentToSd, usbslmReadSd, usbslmUploadSdToFmem,
        usbslmStartSequence, usbslmStopSequence, usbslmLoadCsvFile
    });
})();
