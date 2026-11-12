"""Regression tests for Fourier-plane sequence (video) simulation and GIF export."""

import base64
import io
import unittest

import numpy as np
from flask import Flask
from PIL import Image

import app as web_app

SINGLE_ROUTE = '/api/simulate/fourier'
SEQUENCE_ROUTE = '/api/simulate/fourier/sequence'
GIF_ROUTE = '/api/simulate/fourier/export-gif'


def make_phase_data_url(gray_array):
    """将灰度数组编码为 PNG base64 data URL"""
    img = Image.fromarray(gray_array.astype(np.uint8), mode='L')
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


def make_grating(size, period):
    """生成竖直周期光栅相位图，不同周期产生不同的远场衍射图案"""
    x = np.arange(size)
    gray = 127.5 * (1 + np.sin(2 * np.pi * x / period))
    return np.tile(gray, (size, 1))


class FourierSequenceTestCase(unittest.TestCase):
    """批量序列模拟与 GIF 导出接口测试（不访问数据库）"""

    @classmethod
    def setUpClass(cls):
        cls.test_app = Flask('fourier-seq-test-app', static_folder=None)
        cls.test_app.config.update(web_app.app.config)
        cls.test_app.config['TESTING'] = True

        routes = {SINGLE_ROUTE, SEQUENCE_ROUTE, GIF_ROUTE}
        registered = set()
        for rule in web_app.app.url_map.iter_rules():
            if rule.rule in routes:
                cls.test_app.add_url_rule(
                    rule.rule,
                    endpoint=rule.endpoint,
                    view_func=web_app.app.view_functions[rule.endpoint],
                    methods=rule.methods,
                    provide_automatic_options=rule.provide_automatic_options
                )
                registered.add(rule.rule)
        missing = routes - registered
        if missing:
            raise AssertionError(f'Missing routes for tests: {sorted(missing)}')

        cls.client = cls.test_app.test_client()

    def test_sequence_simulation_returns_per_frame_intensity_images(self):
        payload = {
            'phase_images': [
                make_phase_data_url(make_grating(64, 8)),
                make_phase_data_url(make_grating(64, 16)),
                make_phase_data_url(make_grating(64, 24)),
            ],
            'width': 64,
            'height': 64,
        }
        response = self.client.post(SEQUENCE_ROUTE, json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['frame_count'], 3)
        self.assertEqual(len(data['frames']), 3)

        color_images = []
        for index, frame in enumerate(data['frames']):
            self.assertEqual(frame['index'], index)
            for key in ('intensity_log', 'intensity_raw', 'intensity_color'):
                self.assertIn('base64,', frame[key])
                Image.open(
                    io.BytesIO(base64.b64decode(frame[key].split(',', 1)[1]))
                ).load()
            self.assertGreaterEqual(frame['mean_intensity'], 0.0)
            self.assertLessEqual(frame['mean_intensity'], 1.0)
            self.assertGreaterEqual(frame['peak_intensity'], frame['mean_intensity'])
            color_images.append(frame['intensity_color'])

        # 不同周期的相位图应产生不同的傅里叶面强度
        self.assertEqual(len(set(color_images)), 3)

    def test_sequence_frame_order_matches_input_order(self):
        """帧顺序必须与输入顺序一致，且与单帧模拟逐字节一致（前端排序与分布面板同步依赖该契约）"""
        periods = (8, 16, 24)
        payload = {
            'phase_images': [
                make_phase_data_url(make_grating(64, period)) for period in periods
            ],
            'width': 64,
            'height': 64,
        }
        response = self.client.post(SEQUENCE_ROUTE, json=payload)
        self.assertEqual(response.status_code, 200)
        frames = response.get_json()['frames']
        self.assertEqual([frame['index'] for frame in frames], [0, 1, 2])

        for frame, period in zip(frames, periods):
            single = self.client.post(SINGLE_ROUTE, json={
                'phase_image': make_phase_data_url(make_grating(64, period)),
                'width': 64,
                'height': 64,
            }).get_json()
            self.assertEqual(frame['intensity_log'], single['intensity_log_image'])
            self.assertEqual(frame['intensity_raw'], single['intensity_raw_image'])
            self.assertEqual(frame['intensity_color'], single['intensity_color_image'])

    def test_sequence_per_frame_three_intensity_representations(self):
        """每帧必须同时返回彩色/对数/原始三种强度表示，且互不相同（分布面板同步数据源）"""
        payload = {
            'phase_images': [make_phase_data_url(make_grating(64, 10))],
            'width': 64,
            'height': 64,
        }
        response = self.client.post(SEQUENCE_ROUTE, json=payload)
        self.assertEqual(response.status_code, 200)
        frame = response.get_json()['frames'][0]

        images = {}
        for key, mode in (('intensity_color', 'RGB'),
                          ('intensity_log', 'L'),
                          ('intensity_raw', 'L')):
            img = Image.open(
                io.BytesIO(base64.b64decode(frame[key].split(',', 1)[1]))
            )
            self.assertEqual(img.mode, mode)
            self.assertEqual(img.size, (64, 64))
            images[key] = img.convert('RGB')

        # 非均匀相位下，对数与原始归一化结果应不同，彩色映射应与灰度不同
        self.assertNotEqual(
            images['intensity_log'].tobytes(), images['intensity_raw'].tobytes()
        )
        self.assertNotEqual(
            images['intensity_color'].tobytes(), images['intensity_log'].tobytes()
        )

    def test_single_simulation_still_works_after_refactor(self):
        payload = {
            'phase_image': make_phase_data_url(make_grating(64, 12)),
            'width': 64,
            'height': 64,
        }
        response = self.client.post(SINGLE_ROUTE, json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        for key in ('intensity_log_image', 'intensity_raw_image',
                    'intensity_color_image', 'illumination_preview'):
            self.assertIn('base64,', data[key])

    def test_sequence_accepts_gaussian_illumination(self):
        payload = {
            'phase_images': [make_phase_data_url(make_grating(64, 8))],
            'width': 64,
            'height': 64,
            'illumination_type': 'gaussian',
            'beam_radius': 20,
            'colormap': 'viridis',
        }
        response = self.client.post(SEQUENCE_ROUTE, json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['illumination_type'], 'gaussian')
        self.assertEqual(data['colormap'], 'viridis')

    def test_sequence_rejects_empty_frame_list(self):
        response = self.client.post(SEQUENCE_ROUTE, json={'phase_images': []})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_sequence_rejects_non_string_frames(self):
        response = self.client.post(
            SEQUENCE_ROUTE, json={'phase_images': ['valid', 123]}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('无效', response.get_json()['error'])

    def test_sequence_rejects_too_many_frames(self):
        frame = make_phase_data_url(make_grating(32, 8))
        response = self.client.post(
            SEQUENCE_ROUTE,
            json={
                'phase_images':
                    [frame] * (web_app.FourierSimulator.MAX_SEQUENCE_FRAMES + 1)
            }
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('帧数过多', response.get_json()['error'])

    def test_sequence_rejects_invalid_base64(self):
        response = self.client.post(
            SEQUENCE_ROUTE, json={'phase_images': ['not-a-valid-image']}
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_export_gif_returns_multi_frame_animation(self):
        frames = [make_phase_data_url(make_grating(64, p)) for p in (8, 16, 24)]
        response = self.client.post(
            GIF_ROUTE,
            json={
                'phase_images': frames,
                'width': 64,
                'height': 64,
                'frame_duration_ms': 100
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'image/gif')

        gif = Image.open(io.BytesIO(response.data))
        self.assertEqual(gif.format, 'GIF')
        self.assertEqual(gif.n_frames, 3)
        self.assertEqual(gif.info.get('duration'), 100)
        self.assertEqual(gif.info.get('loop'), 0)

    def test_export_gif_rejects_unknown_intensity_mode(self):
        frame = make_phase_data_url(make_grating(64, 8))
        response = self.client.post(
            GIF_ROUTE,
            json={'phase_images': [frame], 'intensity_mode': 'rainbow'}
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['success'])

    def test_export_gif_clamps_frame_duration(self):
        frame = make_phase_data_url(make_grating(64, 8))
        response = self.client.post(
            GIF_ROUTE,
            json={'phase_images': [frame], 'frame_duration_ms': 99999}
        )
        self.assertEqual(response.status_code, 200)
        gif = Image.open(io.BytesIO(response.data))
        self.assertEqual(gif.info.get('duration'), 2000)


if __name__ == '__main__':
    unittest.main()
