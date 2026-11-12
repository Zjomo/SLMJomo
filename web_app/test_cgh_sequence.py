"""CGH 相位图序列 ZIP 导出接口回归测试（正常/异常/边界）。"""

import base64
import io
import unittest
import zipfile

import numpy as np
from flask import Flask
from PIL import Image

import app as web_app


def make_gray_png_data_uri(width=8, height=8, value=128):
    """生成 8-bit 灰度 PNG 的 data URI 字符串"""
    array = np.full((height, width), value, dtype=np.uint8)
    img = Image.fromarray(array, mode='L')
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


class CGHSequenceExportTests(unittest.TestCase):
    def setUp(self):
        self.test_app = Flask('cgh-sequence-test-app', static_folder=None)
        self.test_app.config.update(TESTING=True)
        self.test_app.add_url_rule(
            '/api/cgh/sequence/export',
            endpoint='export_cgh_sequence_zip',
            view_func=web_app.export_cgh_sequence_zip,
            methods=['POST']
        )
        self.client = self.test_app.test_client()

    def post_export(self, payload):
        return self.client.post('/api/cgh/sequence/export', json=payload)

    # ------------------- 正常路径 -------------------

    def test_export_zip_contains_ordered_8bit_bmp_frames(self):
        frames = [
            make_gray_png_data_uri(value=10),
            make_gray_png_data_uri(value=128),
            make_gray_png_data_uri(value=250)
        ]
        response = self.post_export({'frames': frames})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'application/zip')
        self.assertTrue(response.headers['Content-Disposition'].startswith('attachment'))
        self.assertIn('.zip', response.headers['Content-Disposition'])

        archive = zipfile.ZipFile(io.BytesIO(response.data))
        names = archive.namelist()
        self.assertEqual(names, [
            'cgh_frame_001.bmp', 'cgh_frame_002.bmp', 'cgh_frame_003.bmp'
        ])
        for name, expected_value in zip(names, (10, 128, 250)):
            img = Image.open(io.BytesIO(archive.read(name)))
            self.assertEqual(img.mode, 'L')
            self.assertEqual(img.size, (8, 8))
            self.assertEqual(np.array(img)[0, 0], expected_value)

    def test_export_single_frame_padded_names(self):
        response = self.post_export({'frames': [make_gray_png_data_uri(value=64)]})
        self.assertEqual(response.status_code, 200)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        self.assertEqual(archive.namelist(), ['cgh_frame_001.bmp'])

    def test_export_200_frame_boundary(self):
        frames = [make_gray_png_data_uri(value=i % 256) for i in range(200)]
        response = self.post_export({'frames': frames})
        self.assertEqual(response.status_code, 200)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        self.assertEqual(len(archive.namelist()), 200)
        self.assertEqual(archive.namelist()[-1], 'cgh_frame_200.bmp')

    def test_export_sanitizes_prefix(self):
        response = self.post_export({
            'frames': [make_gray_png_data_uri()],
            'prefix': 'my Movie<v2>/..'
        })
        self.assertEqual(response.status_code, 200)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        self.assertEqual(archive.namelist(), ['myMoviev2_frame_001.bmp'])

    def test_export_accepts_plain_base64_without_data_uri(self):
        data_uri = make_gray_png_data_uri(value=7)
        plain = data_uri.split(',', 1)[1]
        response = self.post_export({'frames': [plain]})
        self.assertEqual(response.status_code, 200)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        img = Image.open(io.BytesIO(archive.read('cgh_frame_001.bmp')))
        self.assertEqual(np.array(img)[0, 0], 7)

    # ------------------- 异常与边界 -------------------

    def test_export_rejects_missing_frames(self):
        response = self.post_export({})
        self.assertEqual(response.status_code, 400)
        self.assertIn('frames', response.get_json()['error'])

    def test_export_rejects_empty_frames(self):
        response = self.post_export({'frames': []})
        self.assertEqual(response.status_code, 400)

    def test_export_rejects_non_list_frames(self):
        response = self.post_export({'frames': 'data:image/png;base64,xxxx'})
        self.assertEqual(response.status_code, 400)

    def test_export_rejects_too_many_frames(self):
        frames = [make_gray_png_data_uri() for _ in range(201)]
        response = self.post_export({'frames': frames})
        self.assertEqual(response.status_code, 400)
        self.assertIn('200', response.get_json()['error'])

    def test_export_rejects_invalid_image_data(self):
        response = self.post_export({'frames': ['not-a-valid-image']})
        self.assertEqual(response.status_code, 400)
        self.assertIn('第 1 帧', response.get_json()['error'])

    def test_export_rejects_invalid_item_types(self):
        response = self.post_export({'frames': [make_gray_png_data_uri(), None, 123]})
        self.assertEqual(response.status_code, 400)
        self.assertIn('第 2 帧', response.get_json()['error'])

    def test_export_rejects_empty_base64_payload(self):
        response = self.post_export({'frames': ['data:image/png;base64,']})
        self.assertEqual(response.status_code, 400)

    def test_export_rejects_non_string_prefix(self):
        response = self.post_export({
            'frames': [make_gray_png_data_uri()],
            'prefix': 123
        })
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
