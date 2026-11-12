"""
USB_SLMControl 路由层（Flask Blueprint）
========================================
REST API 前缀: /api/usb_slm
对应 Hamamatsu USB_SLMControl.exe 的功能还原，详见 usb_slm_control.py。
"""

import base64
import io
import os
import tempfile
import binascii

from flask import Blueprint, jsonify, request
from PIL import Image

from usb_slm_control import (
    USB_SLMController, SLMDriverError, parse_sequence_csv, validate_mode,
    X_PIXEL, Y_PIXEL, ARRAY_SIZE,
)

usb_slm_bp = Blueprint('usb_slm', __name__, url_prefix='/api/usb_slm')


def _controller() -> USB_SLMController:
    return USB_SLMController.instance()


def _ok(payload: dict, status: int = 200):
    return jsonify(payload), status


def _err(exc: Exception, status: int = 400):
    return jsonify({'success': False, 'error': str(exc)}), status


def _decode_image_bytes(image_b64: str) -> bytes:
    """base64 图像（dataURL 或裸 base64）-> 1272x1024 8-bit 灰度原始字节。"""
    try:
        if ',' in image_b64 and image_b64.strip().startswith('data:'):
            image_b64 = image_b64.split(',', 1)[1]
        raw = base64.b64decode(image_b64)
    except (binascii.Error, ValueError, TypeError):
        raise SLMDriverError('图像 base64 解码失败') from None
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception:
        raise SLMDriverError('无法识别的图像数据') from None
    img = img.convert('L')
    if img.size != (X_PIXEL, Y_PIXEL):
        img = img.resize((X_PIXEL, Y_PIXEL), Image.NEAREST)
    return img.tobytes()


def _bytes_to_png_dataurl(data: bytes) -> str:
    img = Image.frombytes('L', (X_PIXEL, Y_PIXEL), data)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def _save_temp_bmp(file_storage) -> str:
    """上传的 BMP 校验并保存为临时文件（写 BMP 路径 API 需要）。"""
    data = file_storage.read()
    try:
        img = Image.open(io.BytesIO(data))
    except Exception:
        raise SLMDriverError('上传文件不是有效图像') from None
    img = img.convert('L')
    if img.size != (X_PIXEL, Y_PIXEL):
        img = img.resize((X_PIXEL, Y_PIXEL), Image.NEAREST)
    fd, path = tempfile.mkstemp(suffix='.bmp', prefix='usb_slm_')
    with os.fdopen(fd, 'wb') as fh:
        img.save(fh, format='BMP')
    return path


# ==================== 连接 / 状态 ====================
@usb_slm_bp.route('/status', methods=['GET'])
def api_status():
    return _ok({'success': True, **_controller().status()})


@usb_slm_bp.route('/connect', methods=['POST'])
def api_connect():
    data = request.get_json(silent=True) or {}
    try:
        st = _controller().connect(
            driver=str(data.get('driver', 'auto')),
            probe_count=int(data.get('probe_count', 8)))
        return _ok({'success': True, 'message': f"已连接（{st['driver']} 模式）", **st})
    except SLMDriverError as exc:
        return _err(exc, 503)
    except Exception as exc:  # noqa: BLE001
        return _err(exc, 500)


@usb_slm_bp.route('/disconnect', methods=['POST'])
def api_disconnect():
    try:
        return _ok({'success': True, 'message': '已断开连接', **_controller().disconnect()})
    except Exception as exc:  # noqa: BLE001
        return _err(exc, 500)


@usb_slm_bp.route('/reboot', methods=['POST'])
def api_reboot():
    data = request.get_json(silent=True) or {}
    try:
        return _ok({'success': True, 'message': '控制器重启指令已发送，请稍后重新连接',
                    **_controller().reboot(data.get('bid'))})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except Exception as exc:  # noqa: BLE001
        return _err(exc, 500)


@usb_slm_bp.route('/device-info', methods=['GET'])
def api_device_info():
    bid = request.args.get('bid')
    try:
        info = _controller().device_info(int(bid) if bid not in (None, '') else None)
        return _ok({'success': True, **info})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except Exception as exc:  # noqa: BLE001
        return _err(exc, 500)


@usb_slm_bp.route('/mode', methods=['POST'])
def api_mode():
    data = request.get_json(silent=True) or {}
    try:
        mode = validate_mode(int(data.get('mode', 0)))
    except (SLMDriverError, TypeError, ValueError):
        return _err(SLMDriverError('mode 必须是 0 或 1'), 400)
    try:
        return _ok({'success': True,
                    **_controller().set_mode(mode, data.get('bid'))})
    except SLMDriverError as exc:
        return _err(exc, 409)


# ==================== 帧存储器 ====================
@usb_slm_bp.route('/fmem/write', methods=['POST'])
def api_fmem_write():
    data = request.get_json(silent=True) or {}
    if not data.get('image_b64'):
        return _err(SLMDriverError('缺少 image_b64 图像数据'), 400)
    try:
        payload = _decode_image_bytes(data['image_b64'])
    except SLMDriverError as exc:
        return _err(exc, 400)  # 图像数据非法属于客户端输入错误
    try:
        result = _controller().write_fmem(payload, int(data.get('slot', 0)),
                                          data.get('bid'))
        return _ok({'success': True, 'message': f"已写入帧存储器槽位 {result['slot']}",
                    **result})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except (TypeError, ValueError):
        return _err(SLMDriverError('slot 必须为 0~818 的整数'), 400)


@usb_slm_bp.route('/fmem/write-bmp', methods=['POST'])
def api_fmem_write_bmp():
    f = request.files.get('file')
    if f is None:
        return _err(SLMDriverError('缺少上传的 BMP 文件（字段名 file）'), 400)
    tmp_path = None
    try:
        tmp_path = _save_temp_bmp(f)
        slot = int(request.form.get('slot', 0))
        bid = request.form.get('bid')
        result = _controller().write_fmem_bmp(
            tmp_path, slot, int(bid) if bid not in (None, '') else None)
        return _ok({'success': True, 'message': f"已写入帧存储器槽位 {result['slot']}",
                    **result})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except (TypeError, ValueError):
        return _err(SLMDriverError('slot 必须为 0~818 的整数'), 400)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@usb_slm_bp.route('/display', methods=['POST'])
def api_display():
    data = request.get_json(silent=True) or {}
    try:
        result = _controller().display(int(data.get('slot', 0)), data.get('bid'))
        return _ok({'success': True, 'message': f"已切换显示槽位 {result['slot']}",
                    **result})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except (TypeError, ValueError):
        return _err(SLMDriverError('slot 必须为 0~818 的整数'), 400)


@usb_slm_bp.route('/fmem/read', methods=['GET'])
def api_fmem_read():
    slot = request.args.get('slot', '0')
    bid = request.args.get('bid')
    try:
        data = _controller().read_fmem(int(slot),
                                       int(bid) if bid not in (None, '') else None)
        return _ok({'success': True, 'slot': int(slot),
                    'image': _bytes_to_png_dataurl(data)})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except ValueError:
        return _err(SLMDriverError('slot 必须为整数'), 400)


@usb_slm_bp.route('/display/readback', methods=['GET'])
def api_display_readback():
    bid = request.args.get('bid')
    try:
        data = _controller().read_display(int(bid) if bid not in (None, '') else None)
        return _ok({'success': True, 'image': _bytes_to_png_dataurl(data)})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except ValueError:
        return _err(SLMDriverError('bid 必须为整数'), 400)


# ==================== SD 卡 ====================
@usb_slm_bp.route('/sd/write', methods=['POST'])
def api_sd_write():
    data = request.get_json(silent=True) or {}
    if not data.get('image_b64'):
        return _err(SLMDriverError('缺少 image_b64 图像数据'), 400)
    try:
        payload = _decode_image_bytes(data['image_b64'])
    except SLMDriverError as exc:
        return _err(exc, 400)  # 图像数据非法属于客户端输入错误
    try:
        result = _controller().write_sd(payload, int(data.get('slot', 0)),
                                        data.get('bid'))
        return _ok({'success': True, 'message': f"已写入 SD 卡槽位 {result['slot']}",
                    **result})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except (TypeError, ValueError):
        return _err(SLMDriverError('slot 必须为 0~5658 的整数'), 400)


@usb_slm_bp.route('/sd/read', methods=['GET'])
def api_sd_read():
    slot = request.args.get('slot', '0')
    bid = request.args.get('bid')
    try:
        data = _controller().read_sd(int(slot),
                                     int(bid) if bid not in (None, '') else None)
        return _ok({'success': True, 'slot': int(slot),
                    'image': _bytes_to_png_dataurl(data)})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except ValueError:
        return _err(SLMDriverError('slot 必须为整数'), 400)


@usb_slm_bp.route('/sd/upload', methods=['POST'])
def api_sd_upload():
    data = request.get_json(silent=True) or {}
    try:
        result = _controller().upload_sd_to_fmem(
            int(data.get('sd_slot', 0)), int(data.get('fmem_slot', 0)), data.get('bid'))
        return _ok({'success': True,
                    'message': f"SD 槽 {result['sd_slot']} 已上传到帧存储器槽 {result['fmem_slot']}",
                    **result})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except (TypeError, ValueError):
        return _err(SLMDriverError('槽位必须为整数'), 400)


# ==================== 序列播放 ====================
@usb_slm_bp.route('/sequence/start', methods=['POST'])
def api_sequence_start():
    data = request.get_json(silent=True) or {}
    try:
        if data.get('csv_text'):
            steps = parse_sequence_csv(data['csv_text'])
        elif data.get('steps'):
            steps = data['steps']
        else:
            return _err(SLMDriverError('需要 csv_text 或 steps 序列数据'), 400)
        st = _controller().start_sequence(steps, loop=bool(data.get('loop', True)),
                                          bid=data.get('bid'))
        return _ok({'success': True, 'message': f"序列播放开始（{len(steps)} 帧）", **st})
    except SLMDriverError as exc:
        return _err(exc, 409)
    except Exception as exc:  # noqa: BLE001
        return _err(exc, 500)


@usb_slm_bp.route('/sequence/stop', methods=['POST'])
def api_sequence_stop():
    try:
        st = _controller().stop_sequence()
        return _ok({'success': True, 'message': '序列播放已停止', **st})
    except Exception as exc:  # noqa: BLE001
        return _err(exc, 500)


@usb_slm_bp.route('/sequence/state', methods=['GET'])
def api_sequence_state():
    return _ok({'success': True, **_controller().sequence_state()})
