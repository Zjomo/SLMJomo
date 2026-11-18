"""
批量相位图生成测试（/api/generate/batch_spots）
================================================
覆盖：安全表达式求值、变量序列、重合帧降级、ZIP 打包内容、错误路径。
"""

import io
import json
import zipfile
import unittest

from flask import Flask
from PIL import Image

from app import (
    _batch_merge_if_coincident,
    _batch_safe_expr,
    _batch_variable_values,
    app as web_app,
)


class SafeExprTests(unittest.TestCase):
    def test_numeric_and_variable(self):
        self.assertEqual(_batch_safe_expr('-d', {'d': 2.5}), -2.5)
        self.assertEqual(_batch_safe_expr('d*0.5', {'d': 4.0}), 2.0)
        self.assertEqual(_batch_safe_expr('d*d', {'d': 3.0}), 9.0)
        self.assertEqual(_batch_safe_expr('(d-1)/2', {'d': 5.0}), 2.0)
        self.assertEqual(_batch_safe_expr('0', {'d': 1.0}), 0.0)

    def test_unknown_variable(self):
        with self.assertRaisesRegex(ValueError, '未知变量'):
            _batch_safe_expr('x + d', {'d': 1.0})

    def test_rejects_import_and_calls(self):
        with self.assertRaises(ValueError):
            _batch_safe_expr('__import__("os").system("dir")', {'d': 1.0})
        with self.assertRaises(ValueError):
            _batch_safe_expr('d.__class__', {'d': 1.0})
        with self.assertRaises(ValueError):
            _batch_safe_expr('abs(d)', {'d': 1.0})

    def test_rejects_division_by_zero(self):
        with self.assertRaisesRegex(ValueError, '除零'):
            _batch_safe_expr('d/0', {'d': 1.0})

    def test_rejects_infinite_result(self):
        with self.assertRaisesRegex(ValueError, '非有限'):
            _batch_safe_expr('d*1e308*10', {'d': 1.0})


class VariableValuesTests(unittest.TestCase):
    def test_descending_sequence(self):
        name, values = _batch_variable_values(
            {'name': 'd', 'start': 3.0, 'stop': 0.0, 'step': 0.1})
        self.assertEqual(name, 'd')
        self.assertEqual(len(values), 31)
        self.assertAlmostEqual(values[0], 3.0, places=9)
        self.assertAlmostEqual(values[-1], 0.0, places=9)

    def test_count_mode(self):
        _, values = _batch_variable_values(
            {'name': 'd', 'start': 2.0, 'stop': 0.0, 'count': 5})
        self.assertEqual(len(values), 5)
        self.assertAlmostEqual(values[0], 2.0)
        self.assertAlmostEqual(values[-1], 0.0)

    def test_invalid_name(self):
        with self.assertRaisesRegex(ValueError, '变量名'):
            _batch_variable_values({'name': '1bad', 'start': 0, 'stop': 1, 'step': 1})

    def test_step_is_magnitude_direction_from_start_to_stop(self):
        """步长取幅值、方向由起点→终点决定（TODO 场景：3.0 向内 0.1 到 0.0）。"""
        _, values = _batch_variable_values(
            {'name': 'd', 'start': 3.0, 'stop': 0.0, 'step': 0.1})
        self.assertEqual(len(values), 31)
        _, up = _batch_variable_values(
            {'name': 'd', 'start': 0.0, 'stop': 3.0, 'step': 0.1})
        self.assertEqual(len(up), 31)

    def test_count_invalid(self):
        with self.assertRaisesRegex(ValueError, '帧数'):
            _batch_variable_values({'name': 'd', 'start': 1, 'stop': 0, 'count': 0})


class MergeCoincidentTests(unittest.TestCase):
    def test_full_coincidence_merges(self):
        spots = [{'x_mm': 0.0, 'y_mm': 0.0, 'weight': 1.0},
                 {'x_mm': 0.0, 'y_mm': 0.0, 'weight': 1.0},
                 {'x_mm': 0.0, 'y_mm': 0.0, 'weight': 1.0}]
        merged, flag = _batch_merge_if_coincident(spots)
        self.assertTrue(flag)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]['weight'], 3.0)

    def test_non_coincident_kept(self):
        spots = [{'x_mm': -2.0, 'y_mm': 0.0, 'weight': 1.0},
                 {'x_mm': 0.0, 'y_mm': 2.0, 'weight': 1.0}]
        merged, flag = _batch_merge_if_coincident(spots)
        self.assertFalse(flag)
        self.assertEqual(len(merged), 2)


class BatchRouteTests(unittest.TestCase):
    """批量端点集成测试（小图 + 快速算法）。"""

    @classmethod
    def setUpClass(cls):
        web_app.config['TESTING'] = True
        cls.client = web_app.test_client()

    def _payload(self, variable, template=None, **overrides):
        base = {
            'width': 128,
            'height': 128,
            'focal_length': 1000,
            'wavelength': 532,
            'pixel_size_um': 12.5,
            'algorithm': 'uniform_grating',
            'incident_beam_diameter_mm': 10.0,
            'iterations': 10,
            'phase_direction': 'standard',
            'with_lens': True,
        }
        base.update(overrides)
        if template is None:
            template = [{'x_mm': '-d', 'y_mm': 0, 'weight': 1},
                        {'x_mm': 0, 'y_mm': 'd', 'weight': 1},
                        {'x_mm': 'd', 'y_mm': 0, 'weight': 1}]
        return {
            'base_params': base,
            'spots_template': template,
            'variable': variable,
            'frame_duration_ms': 50,
        }

    def _post(self, payload):
        import json as _json
        rv = self.client.post('/api/generate/batch_spots',
                              data=_json.dumps(payload),
                              content_type='application/json')
        return rv

    def test_batch_three_frames_zip(self):
        rv = self._post(self._payload(
            {'name': 'd', 'start': 2.0, 'stop': 1.6, 'step': 0.2}))
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.mimetype, 'application/zip')
        zf = zipfile.ZipFile(io.BytesIO(rv.data))
        names = zf.namelist()
        bmps = [n for n in names if n.startswith('frames/') and n.endswith('.bmp')]
        self.assertEqual(len(bmps), 3)
        self.assertIn('sequence.csv', names)
        self.assertIn('manifest.json', names)
        manifest = json.loads(zf.read('manifest.json').decode('utf-8'))
        self.assertEqual(manifest['frame_count'], 3)
        self.assertEqual(manifest['skipped_count'], 0)
        self.assertEqual(
            [f['value'] for f in manifest['frames']],
            [2.0, 1.8, 1.6])
        self.assertTrue(all(f['status'] == 'ok' for f in manifest['frames']))
        # BMP 内容：1272? 不——本测试用 128x128
        img = Image.open(io.BytesIO(zf.read(bmps[0])))
        self.assertEqual(img.size, (128, 128))
        self.assertEqual(img.mode, 'L')
        # sequence.csv：表头 + 3 帧，可直接导入 USB_SLMControl
        csv_text = zf.read('sequence.csv').decode('utf-8').strip().splitlines()
        self.assertEqual(csv_text[0], 'Slot No.,Duration Time / msec')
        self.assertEqual(csv_text[1:], ['0,50', '1,50', '2,50'])
        # 每帧坐标 CSV
        spot_csv = [n for n in names if n.endswith('.csv') and 'frames/' in n]
        self.assertEqual(len(spot_csv), 3)

    def test_coincident_last_frame_merges(self):
        rv = self._post(self._payload(
            {'name': 'd', 'start': 0.4, 'stop': 0.0, 'step': 0.2}))
        self.assertEqual(rv.status_code, 200)
        manifest = json.loads(zipfile.ZipFile(io.BytesIO(rv.data))
                              .read('manifest.json').decode('utf-8'))
        last = manifest['frames'][-1]
        self.assertEqual(last['status'], 'ok')
        self.assertTrue(last['merged_single_spot'])
        self.assertEqual(len(last['target_spots']), 1)

    def test_skip_errors_records_and_continues(self):
        # gaussian_wgs 的可分辨判据（2·w₀≈0.53mm @128px）下，
        # d=0.2 帧三点相距 0.283mm 被跳过；d>=0.4 正常生成
        rv = self._post(self._payload(
            {'name': 'd', 'start': 0.8, 'stop': 0.2, 'step': 0.2},
            algorithm='gaussian_wgs'))
        self.assertEqual(rv.status_code, 200)
        manifest = json.loads(zipfile.ZipFile(io.BytesIO(rv.data))
                              .read('manifest.json').decode('utf-8'))
        statuses = [f['status'] for f in manifest['frames']]
        self.assertEqual(statuses, ['ok', 'ok', 'ok', 'skipped'])
        self.assertTrue(manifest['frames'][3]['error'])

    def test_strict_mode_fails_batch(self):
        payload = self._payload(
            {'name': 'd', 'start': 0.8, 'stop': 0.2, 'step': 0.2},
            algorithm='gaussian_wgs')
        payload['skip_errors'] = False
        rv = self._post(payload)
        self.assertEqual(rv.status_code, 400)

    def test_single_spot_template(self):
        """等间距 n=1 / 单行模板：单点批量生成。"""
        rv = self._post(self._payload(
            {'name': 'd', 'start': 2.0, 'stop': 1.0, 'step': 1.0},
            template=[{'x_mm': 0, 'y_mm': 0, 'weight': 1}]))
        self.assertEqual(rv.status_code, 200)
        manifest = json.loads(zipfile.ZipFile(io.BytesIO(rv.data))
                              .read('manifest.json').decode('utf-8'))
        self.assertEqual(manifest['frame_count'], 2)
        self.assertTrue(all(len(f['target_spots']) == 1
                            for f in manifest['frames']))

    def test_missing_template(self):
        payload = self._payload({'name': 'd', 'start': 2, 'stop': 1, 'step': 1})
        payload['spots_template'] = []
        rv = self._post(payload)
        self.assertEqual(rv.status_code, 400)

    def test_no_successful_frames(self):
        rv = self._post(self._payload(
            {'name': 'd', 'start': 2.0, 'stop': 1.8, 'step': 0.2},
            template=[{'x_mm': 'd', 'y_mm': 'unknown_var', 'weight': 1}]))
        self.assertEqual(rv.status_code, 400)
        body = rv.get_json()
        self.assertIn('没有任何帧', body['error'])

    def test_frame_limit_guard(self):
        rv = self._post(self._payload(
            {'name': 'd', 'start': 0, 'stop': 1, 'step': 0.0001}))
        self.assertEqual(rv.status_code, 400)


if __name__ == '__main__':
    unittest.main()
