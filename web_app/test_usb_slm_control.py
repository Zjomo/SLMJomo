"""
USB_SLMControl 模块测试
========================
覆盖:
  1. SimulatedDriver 的 SDK 语义（对应 hpkSLMdaLV.dll 20 个函数）
  2. 序列 CSV 解析（与原版 USB_SLMControl.exe 的 Sequence.csv 同格式）
  3. USB_SLMController 连接/写入/显示/序列播放线程
  4. Flask Blueprint 全部 REST 路由（含错误路径）

运行: python -m pytest web_app/test_usb_slm_control.py -v
"""

import base64
import io
import os
import tempfile
import time
import unittest

from flask import Flask
from PIL import Image

from usb_slm_control import (
    ARRAY_SIZE,
    FMEM_SLOT_MAX,
    MODE_DVI,
    MODE_USB_TRIGGER,
    SD_SLOT_MAX,
    SLMDriverError,
    SLMSequenceUploadError,
    Bridge32Driver,
    SimulatedDriver,
    USB_SLMController,
    X_PIXEL,
    Y_PIXEL,
    bridge32_available,
    ensure_bridge_exe,
    find_lvrt_dirs,
    parse_sequence_csv,
)
from usb_slm_routes import usb_slm_bp


def make_gray_bytes(value: int = 128) -> bytes:
    return bytes([value]) * ARRAY_SIZE


def make_bmp_file(directory: str, value: int = 200) -> str:
    img = Image.new('L', (X_PIXEL, Y_PIXEL), value)
    path = os.path.join(directory, 'test_1272x1024.bmp')
    img.save(path, format='BMP')
    return path


def make_png_dataurl(value: int = 90) -> str:
    img = Image.new('L', (X_PIXEL, Y_PIXEL), value)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


class SimulatedDriverTests(unittest.TestCase):
    """SimulatedDriver 需还原 hpkSLMdaLV.dll 的全部语义。"""

    def setUp(self):
        self.drv = SimulatedDriver()

    def test_open_dev_returns_device_list(self):
        bids = self.drv.open_dev()
        self.assertEqual(bids, [0, 1])

    def test_head_serial(self):
        self.drv.open_dev()
        serial = self.drv.check_head_serial(0)
        self.assertTrue(serial.startswith('X'))
        self.assertLessEqual(len(serial), 11)

    def test_fmem_write_read_roundtrip(self):
        self.drv.open_dev()
        payload = make_gray_bytes(77)
        self.drv.write_fmem_array(0, payload, 5)
        self.assertEqual(self.drv.check_fmem_slot(0, 5), payload)

    def test_fmem_slot_out_of_range(self):
        for bad in (-1, FMEM_SLOT_MAX + 1):
            with self.assertRaises(SLMDriverError):
                self.drv.write_fmem_array(0, make_gray_bytes(), bad)
            with self.assertRaises(SLMDriverError):
                self.drv.check_fmem_slot(0, bad)

    def test_fmem_wrong_array_size(self):
        with self.assertRaises(SLMDriverError):
            self.drv.write_fmem_array(0, b'\x00' * 100, 0)

    def test_change_disp_slot_and_check_disp_img(self):
        self.drv.open_dev()
        payload = make_gray_bytes(33)
        self.drv.write_fmem_array(0, payload, 3)
        self.drv.change_disp_slot(0, 3)
        self.assertEqual(self.drv.check_disp_img(0), payload)

    def test_temp_returns_two_values(self):
        head, cb = self.drv.check_temp(0)
        self.assertTrue(25.0 < head < 35.0)
        self.assertTrue(30.0 < cb < 40.0)

    def test_mode_and_led_interplay(self):
        self.drv.open_dev()
        self.assertEqual(self.drv.mode_check(0), MODE_DVI)
        self.assertEqual(self.drv.check_led(0), 0)  # DVI 模式 LED 熄灭
        self.drv.mode_select(0, MODE_USB_TRIGGER)
        self.assertEqual(self.drv.mode_check(0), MODE_USB_TRIGGER)
        self.assertEqual(self.drv.check_led(0), 1)  # USB/Trigger 模式 LED10 亮
        with self.assertRaises(SLMDriverError):
            self.drv.mode_select(0, 2)

    def test_sd_write_read_upload(self):
        self.drv.open_dev()
        payload = make_gray_bytes(111)
        self.drv.write_sd_array(0, payload, 10)
        self.assertEqual(self.drv.check_sd_slot(0, 10), payload)
        # SD -> FMem 上传
        self.drv.upload_sd_to_fmem(0, 10, 7)
        self.assertEqual(self.drv.check_fmem_slot(0, 7), payload)
        with self.assertRaises(SLMDriverError):
            self.drv.write_sd_array(0, payload, SD_SLOT_MAX + 1)

    def test_bmp_path_write(self):
        self.drv.open_dev()
        with tempfile.TemporaryDirectory() as tmp:
            bmp = make_bmp_file(tmp, 222)
            self.drv.write_fmem_bmp_path(0, bmp, 1)
            data = self.drv.check_fmem_slot(0, 1)
            self.assertEqual(set(data), {222})
            with self.assertRaises(SLMDriverError):
                self.drv.write_fmem_bmp_path(0, os.path.join(tmp, 'missing.bmp'), 1)

    def test_reboot_breaks_connection(self):
        self.drv.open_dev()
        self.drv.reboot(0)
        self.assertFalse(self.drv._opened)


class SequenceCsvTests(unittest.TestCase):
    """与原版 exe 的 Sequence.csv 完全同格式（含 BOM 与表头）。"""

    EXE_CSV = (
        '\ufeffSlot No.,Duration Time / msec\n'
        '0,50\n1,50\n2,100\n3,100\n4,200\n5,200\n6,300\n7,300\n'
        '8,400\n9,400\n10,500\n2,200\n4,200\n6,200\n'
    )

    def test_parse_exe_sequence_csv(self):
        steps = parse_sequence_csv(self.EXE_CSV)
        self.assertEqual(len(steps), 14)
        self.assertEqual(steps[0], {'slot': 0, 'duration_ms': 50})
        self.assertEqual(steps[-1], {'slot': 6, 'duration_ms': 200})

    def test_parse_rejects_empty(self):
        with self.assertRaises(SLMDriverError):
            parse_sequence_csv('Slot No.,Duration\n')
        with self.assertRaises(SLMDriverError):
            parse_sequence_csv('')

    def test_parse_skips_garbage_lines(self):
        text = 'Slot No.,Duration Time / msec\n0,100\nbad line\n1,50\n'
        steps = parse_sequence_csv(text)
        self.assertEqual(steps, [{'slot': 0, 'duration_ms': 100},
                                 {'slot': 1, 'duration_ms': 50}])


class ControllerTests(unittest.TestCase):
    """控制器单例：连接、读写、序列播放线程。"""

    def setUp(self):
        self.ctrl = USB_SLMController.instance()
        try:
            self.ctrl.stop_sequence()
        except Exception:
            pass
        self.ctrl.disconnect()

    def tearDown(self):
        self.ctrl.disconnect()

    def test_connect_sim_and_status(self):
        st = self.ctrl.connect(driver='sim')
        self.assertTrue(st['connected'])
        self.assertEqual(st['driver'], 'sim')
        self.assertIn(0, st['devices'])

    def test_operations_require_connect(self):
        with self.assertRaises(SLMDriverError):
            self.ctrl.write_fmem(make_gray_bytes(), 0)
        with self.assertRaises(SLMDriverError):
            self.ctrl.display(0)

    def test_write_display_readback(self):
        self.ctrl.connect(driver='sim')
        payload = make_gray_bytes(64)
        self.ctrl.write_fmem(payload, 12)
        self.ctrl.display(12)
        self.assertEqual(self.ctrl.read_display(), payload)
        self.assertEqual(self.ctrl.read_fmem(12), payload)

    def test_device_info(self):
        self.ctrl.connect(driver='sim')
        info = self.ctrl.device_info()
        self.assertEqual(info['bid'], 0)
        self.assertIn(info['mode'], (MODE_DVI, MODE_USB_TRIGGER))
        self.assertTrue(info['head_serial'])

    def test_sequence_play_and_stop(self):
        self.ctrl.connect(driver='sim')
        steps = [{'slot': 1, 'duration_ms': 60},
                 {'slot': 2, 'duration_ms': 60},
                 {'slot': 3, 'duration_ms': 60}]
        st = self.ctrl.start_sequence(steps, loop=True)
        self.assertTrue(st['playing'])
        self.assertEqual(st['frame_count'], 3)
        time.sleep(0.15)
        mid = self.ctrl.sequence_state()
        self.assertTrue(mid['playing'])
        self.assertIn(mid['current_slot'], (1, 2, 3))
        final = self.ctrl.stop_sequence()
        self.assertFalse(final['playing'])

    def test_sequence_validation(self):
        self.ctrl.connect(driver='sim')
        with self.assertRaises(SLMDriverError):
            self.ctrl.start_sequence([])
        with self.assertRaises(SLMDriverError):
            self.ctrl.start_sequence([{'slot': 9999, 'duration_ms': 50}])
        with self.assertRaises(SLMDriverError):
            self.ctrl.start_sequence([{'slot': 0, 'duration_ms': 0}])

    def test_first_frame_switch_failure_does_not_start_playback(self):
        self.ctrl.connect(driver='sim')
        driver = self.ctrl._driver
        original = driver.change_disp_slot

        def fail_first(*args, **kwargs):
            raise SLMDriverError('simulated first-frame switch failure')

        driver.change_disp_slot = fail_first
        try:
            with self.assertRaisesRegex(SLMDriverError, '首帧切槽失败'):
                self.ctrl.start_sequence([{'slot': 1, 'duration_ms': 50}], loop=False)
            state = self.ctrl.sequence_state()
            self.assertFalse(state['playing'])
            self.assertIn('simulated first-frame', state['error'])
        finally:
            driver.change_disp_slot = original

    def test_mid_sequence_switch_failure_stops_and_reports_error(self):
        self.ctrl.connect(driver='sim')
        driver = self.ctrl._driver
        original = driver.change_disp_slot
        calls = {'count': 0}

        def fail_after_first(*args, **kwargs):
            calls['count'] += 1
            if calls['count'] >= 3:
                raise SLMDriverError('simulated mid-sequence switch failure')
            return original(*args, **kwargs)

        driver.change_disp_slot = fail_after_first
        try:
            self.ctrl.start_sequence(
                [{'slot': 1, 'duration_ms': 10}, {'slot': 2, 'duration_ms': 10}],
                loop=False,
            )
            deadline = time.time() + 1
            while self.ctrl.sequence_state()['playing'] and time.time() < deadline:
                time.sleep(0.01)
            state = self.ctrl.sequence_state()
            self.assertFalse(state['playing'])
            self.assertIn('simulated mid-sequence', state['error'])
        finally:
            driver.change_disp_slot = original

    def test_batch_upload_rolls_back_all_target_slots_on_write_failure(self):
        self.ctrl.connect(driver='sim')
        original_values = {
            4: make_gray_bytes(17),
            5: make_gray_bytes(23),
        }
        for slot, payload in original_values.items():
            self.ctrl.write_fmem(payload, slot)
        driver = self.ctrl._driver
        original_write = driver.write_fmem_array

        def fail_second(bid, data, slot):
            original_write(bid, data, slot)
            if slot == 5 and data != original_values[slot]:
                raise SLMDriverError('simulated write failure')

        driver.write_fmem_array = fail_second
        try:
            with self.assertRaises(SLMSequenceUploadError) as caught:
                self.ctrl.write_fmem_sequence(
                    [make_gray_bytes(101), make_gray_bytes(202)],
                    [{'slot': 4, 'duration_ms': 20}, {'slot': 5, 'duration_ms': 20}],
                    loop=False,
                )
            self.assertEqual(caught.exception.uploaded_count, 1)
            self.assertEqual(self.ctrl.read_fmem(4), original_values[4])
            self.assertEqual(self.ctrl.read_fmem(5), original_values[5])
        finally:
            driver.write_fmem_array = original_write

    def test_double_start_rejected(self):
        self.ctrl.connect(driver='sim')
        self.ctrl.start_sequence([{'slot': 0, 'duration_ms': 500}], loop=False)
        with self.assertRaises(SLMDriverError):
            self.ctrl.start_sequence([{'slot': 1, 'duration_ms': 100}])
        self.ctrl.stop_sequence()

    def test_connect_auto_falls_back(self):
        """本机无 64 位 LabVIEW Runtime 且无硬件，auto 应优雅回退到模拟驱动。"""
        st = self.ctrl.connect(driver='auto')
        self.assertTrue(st['connected'])
        self.assertIn(st['driver'], ('real', 'bridge32', 'sim'))


@unittest.skipUnless(bridge32_available(), '本机缺少 32 位桥接条件（csc/LVRT/DLL）')
class Bridge32DriverTests(unittest.TestCase):
    """32 位 C# 桥接宿主：编译、握手、真实 Open_Dev 调用。"""

    @classmethod
    def setUpClass(cls):
        cls.exe = ensure_bridge_exe()

    def test_bridge_exe_built(self):
        self.assertTrue(os.path.isfile(self.exe))
        self.assertGreater(os.path.getsize(self.exe), 4096)

    def test_bridge_hello_handshake(self):
        drv = Bridge32Driver()
        try:
            # 构造函数中已完成 hello 握手，此处验证进程存活
            self.assertIsNone(drv._proc.poll())
        finally:
            drv.close()

    def test_bridge_close_releases_process(self):
        drv = Bridge32Driver()
        drv.close()
        self.assertIsNotNone(drv._proc.poll())  # 进程应已退出

    def test_bridge_open_dev_no_hardware(self):
        """无硬件时 Open_Dev 返回空列表；插有硬件则返回设备列表（两种都算链路通）。"""
        drv = Bridge32Driver()
        try:
            devices = drv.open_dev()
            self.assertIsInstance(devices, list)
            if devices:
                drv.close_dev(devices)
        finally:
            drv.close()

    def test_bridge_call_after_close_raises(self):
        drv = Bridge32Driver()
        drv.close()
        with self.assertRaises(SLMDriverError):
            drv.open_dev()

    def test_lvrt_dirs_discovered(self):
        dirs = find_lvrt_dirs()
        self.assertTrue(dirs)
        for d in dirs:
            self.assertTrue(os.path.isfile(os.path.join(d, 'lvrt.dll')))


class UsbSlmRouteTests(unittest.TestCase):
    """Blueprint REST API 全路由测试（不依赖数据库）。"""

    @classmethod
    def setUpClass(cls):
        app = Flask('usb-slm-route-test')
        app.config['TESTING'] = True
        app.register_blueprint(usb_slm_bp)
        cls.client = app.test_client()

    def setUp(self):
        ctrl = USB_SLMController.instance()
        try:
            ctrl.stop_sequence()
        except Exception:
            pass
        ctrl.disconnect()
        rv = self.client.post('/api/usb_slm/connect', json={'driver': 'sim'})
        self.assertEqual(rv.status_code, 200)

    def tearDown(self):
        self.client.post('/api/usb_slm/disconnect')

    # ---- 连接/状态 ----
    def test_status_ok(self):
        rv = self.client.get('/api/usb_slm/status')
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertTrue(body['success'])
        self.assertTrue(body['connected'])

    def test_connect_bad_driver(self):
        self.client.post('/api/usb_slm/disconnect')
        rv = self.client.post('/api/usb_slm/connect', json={'driver': 'nope'})
        self.assertEqual(rv.status_code, 503)
        self.assertFalse(rv.get_json()['success'])

    def test_device_info(self):
        rv = self.client.get('/api/usb_slm/device-info')
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertTrue(body['head_serial'])
        self.assertIn('head_temp', body)
        self.assertIn('led_status', body)
        self.assertIn('io_status', body)

    def test_device_info_when_disconnected(self):
        self.client.post('/api/usb_slm/disconnect')
        rv = self.client.get('/api/usb_slm/device-info')
        self.assertEqual(rv.status_code, 409)

    def test_mode_set(self):
        rv = self.client.post('/api/usb_slm/mode', json={'mode': 1})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()['mode'], MODE_USB_TRIGGER)
        rv = self.client.post('/api/usb_slm/mode', json={'mode': 5})
        self.assertEqual(rv.status_code, 400)

    # ---- 帧存储器 ----
    def test_fmem_write_display_read(self):
        rv = self.client.post('/api/usb_slm/fmem/write',
                              json={'slot': 21, 'image_b64': make_png_dataurl(128)})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()['slot'], 21)

        rv = self.client.post('/api/usb_slm/display', json={'slot': 21})
        self.assertEqual(rv.status_code, 200)

        rv = self.client.get('/api/usb_slm/fmem/read?slot=21')
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.get_json()['image'].startswith('data:image/png;base64,'))

        rv = self.client.get('/api/usb_slm/display/readback')
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.get_json()['image'].startswith('data:image/png;base64,'))

    def test_fmem_write_missing_image(self):
        rv = self.client.post('/api/usb_slm/fmem/write', json={'slot': 0})
        self.assertEqual(rv.status_code, 400)

    def test_fmem_write_bad_base64(self):
        rv = self.client.post('/api/usb_slm/fmem/write',
                              json={'slot': 0, 'image_b64': '%%not-base64%%'})
        self.assertEqual(rv.status_code, 400)

    def test_fmem_slot_out_of_range(self):
        rv = self.client.post('/api/usb_slm/fmem/write',
                              json={'slot': 819, 'image_b64': make_png_dataurl()})
        self.assertEqual(rv.status_code, 409)

    def test_fmem_write_bmp_upload(self):
        with tempfile.TemporaryDirectory() as tmp:
            bmp_path = make_bmp_file(tmp, 150)
            with open(bmp_path, 'rb') as fh:
                rv = self.client.post('/api/usb_slm/fmem/write-bmp',
                                      data={'file': (fh, 'sample.bmp'), 'slot': '30'},
                                      content_type='multipart/form-data')
            self.assertEqual(rv.status_code, 200)
            rv = self.client.get('/api/usb_slm/fmem/read?slot=30')
            self.assertEqual(rv.status_code, 200)
            self.assertTrue(rv.get_json()['image'].startswith('data:image/png;base64,'))

    def test_fmem_write_bmp_missing_file(self):
        rv = self.client.post('/api/usb_slm/fmem/write-bmp',
                              data={'slot': '0'},
                              content_type='multipart/form-data')
        self.assertEqual(rv.status_code, 400)

    # ---- SD 卡 ----
    def test_sd_write_read_upload(self):
        rv = self.client.post('/api/usb_slm/sd/write',
                              json={'slot': 40, 'image_b64': make_png_dataurl(200)})
        self.assertEqual(rv.status_code, 200)
        rv = self.client.get('/api/usb_slm/sd/read?slot=40')
        self.assertEqual(rv.status_code, 200)
        rv = self.client.post('/api/usb_slm/sd/upload',
                              json={'sd_slot': 40, 'fmem_slot': 2})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()['fmem_slot'], 2)

    def test_sd_slot_out_of_range(self):
        rv = self.client.post('/api/usb_slm/sd/write',
                              json={'slot': 5659, 'image_b64': make_png_dataurl()})
        self.assertEqual(rv.status_code, 409)

    # ---- 序列 ----
    def test_sequence_start_state_stop(self):
        csv_text = 'Slot No.,Duration Time / msec\n0,50\n1,50\n2,50\n'
        rv = self.client.post('/api/usb_slm/sequence/start',
                              json={'csv_text': csv_text, 'loop': False})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()['frame_count'], 3)

        time.sleep(0.08)
        rv = self.client.get('/api/usb_slm/sequence/state')
        body = rv.get_json()
        self.assertIn(body['current_slot'], (0, 1, 2, None))

        rv = self.client.post('/api/usb_slm/sequence/stop')
        self.assertEqual(rv.status_code, 200)
        self.assertFalse(rv.get_json()['playing'])

    def test_sequence_start_without_data(self):
        rv = self.client.post('/api/usb_slm/sequence/start', json={})
        self.assertEqual(rv.status_code, 400)

    def test_sequence_start_invalid_csv(self):
        rv = self.client.post('/api/usb_slm/sequence/start',
                              json={'csv_text': 'Slot No.,Duration\n'})
        self.assertEqual(rv.status_code, 409)

    def test_reboot_when_connected(self):
        rv = self.client.post('/api/usb_slm/reboot', json={})
        self.assertEqual(rv.status_code, 200)
        st = self.client.get('/api/usb_slm/status').get_json()
        self.assertFalse(st['connected'])

    def test_reboot_when_disconnected(self):
        self.client.post('/api/usb_slm/disconnect')
        rv = self.client.post('/api/usb_slm/reboot', json={})
        self.assertEqual(rv.status_code, 409)


class AppIntegrationTests(unittest.TestCase):
    """验证主应用 app.py 已正确注册 blueprint。"""

    def test_app_import_registers_blueprint(self):
        import app as web_app_module
        rules = {str(r) for r in web_app_module.app.url_map.iter_rules()}
        for route in ['/api/usb_slm/status', '/api/usb_slm/connect',
                      '/api/usb_slm/fmem/write', '/api/usb_slm/sequence/start']:
            self.assertIn(route, rules, f'主应用缺少路由 {route}')

    def test_index_page_contains_usb_slm_module(self):
        import app as web_app_module
        client = web_app_module.app.test_client()
        rv = client.get('/')
        html = rv.get_data(as_text=True)
        self.assertIn('usb-slm', html)
        self.assertIn('USB_SLMControl', html)
        self.assertIn('js/usb_slm.js', html)


if __name__ == '__main__':
    unittest.main()
