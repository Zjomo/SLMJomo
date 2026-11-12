"""Regression tests for independently positioned focal-plane spots."""

import tempfile
import unittest
from unittest.mock import patch

import numpy as np

import app as web_app
from app import SLMPatternGenerator


class FresnelSpotArrayTests(unittest.TestCase):
    WIDTH = 256
    HEIGHT = 256
    PIXEL_SIZE_UM = 12.5
    WAVELENGTH_NM = 532
    FOCAL_LENGTH_MM = 1000
    BEAM_DIAMETER_MM = 5

    def _generate(self, spots, **kwargs):
        return SLMPatternGenerator.fresnel_three_spots(
            width=self.WIDTH,
            height=self.HEIGHT,
            focal_length=self.FOCAL_LENGTH_MM,
            wavelength=self.WAVELENGTH_NM,
            pixel_size_um=self.PIXEL_SIZE_UM,
            incident_beam_diameter_mm=self.BEAM_DIAMETER_MM,
            iterations=20,
            algorithm='gaussian_wgs',
            with_lens=False,
            target_spots=spots,
            **kwargs
        )

    def _focal_intensity(self, phase):
        pixel_size_mm = self.PIXEL_SIZE_UM / 1000
        x = (np.arange(self.WIDTH) - self.WIDTH // 2) * pixel_size_mm
        y = (np.arange(self.HEIGHT) - self.HEIGHT // 2) * pixel_size_mm
        X, Y = np.meshgrid(x, y)
        illumination = np.exp(
            -(X**2 + Y**2) / (self.BEAM_DIAMETER_MM / 2) ** 2
        )
        field = illumination * np.exp(1j * phase.astype(float) / 255 * 2 * np.pi)
        return np.abs(np.fft.fftshift(
            np.fft.fft2(np.fft.ifftshift(field))
        )) ** 2

    def _output_grid(self):
        step = (
            self.WAVELENGTH_NM / 1e6 * self.FOCAL_LENGTH_MM /
            (self.WIDTH * self.PIXEL_SIZE_UM / 1000)
        )
        coords = (np.arange(self.WIDTH) - self.WIDTH // 2) * step
        return coords, coords, step

    def test_asymmetric_targets_focus_at_their_requested_xy_positions(self):
        x_mm, y_mm, step = self._output_grid()
        expected = [(-5 * step, -10 * step), (8 * step, 15 * step), (24 * step, -20 * step)]
        phase = self._generate([
            {'x_mm': x, 'y_mm': y, 'weight': 1}
            for x, y in expected
        ])
        intensity = self._focal_intensity(phase)

        for target_x, target_y in expected:
            center_x = int(np.argmin(np.abs(x_mm - target_x)))
            center_y = int(np.argmin(np.abs(y_mm - target_y)))
            y0, y1 = max(0, center_y - 2), min(self.HEIGHT, center_y + 3)
            x0, x1 = max(0, center_x - 2), min(self.WIDTH, center_x + 3)
            local = intensity[y0:y1, x0:x1]
            peak_y, peak_x = np.unravel_index(np.argmax(local), local.shape)
            self.assertLessEqual(abs(x0 + peak_x - center_x), 1)
            self.assertLessEqual(abs(y0 + peak_y - center_y), 1)

    def test_moving_one_target_preserves_the_other_target_locations(self):
        _, _, step = self._output_grid()
        original = [
            {'x_mm': -12 * step, 'y_mm': -8 * step, 'weight': 1},
            {'x_mm': 0, 'y_mm': 10 * step, 'weight': 1},
            {'x_mm': 15 * step, 'y_mm': -7 * step, 'weight': 1}
        ]
        moved = [dict(spot) for spot in original]
        moved[1]['x_mm'] = 7 * step
        moved[1]['y_mm'] = 18 * step
        original_intensity = self._focal_intensity(self._generate(original))
        moved_intensity = self._focal_intensity(self._generate(moved))

        def peak_position(intensity, spot):
            x_mm, y_mm, _ = self._output_grid()
            cx = int(np.argmin(np.abs(x_mm - spot['x_mm'])))
            cy = int(np.argmin(np.abs(y_mm - spot['y_mm'])))
            crop = intensity[cy - 2:cy + 3, cx - 2:cx + 3]
            py, px = np.unravel_index(np.argmax(crop), crop.shape)
            return (cx - 2 + px, cy - 2 + py)

        original_peaks = [peak_position(original_intensity, spot) for spot in original]
        moved_peaks = [peak_position(moved_intensity, spot) for spot in moved]
        self.assertNotEqual(original_peaks[1], moved_peaks[1])
        self.assertEqual(original_peaks[0], moved_peaks[0])
        self.assertEqual(original_peaks[2], moved_peaks[2])

    def test_spot_weights_set_relative_focal_power(self):
        _, _, step = self._output_grid()
        spots = [
            {'x_mm': -10 * step, 'y_mm': 0, 'weight': 1},
            {'x_mm': 10 * step, 'y_mm': 0, 'weight': 2}
        ]
        phase = self._generate(spots)
        intensity = self._focal_intensity(phase)
        x_mm, y_mm, _ = self._output_grid()
        powers = []
        for spot in spots:
            cx = int(np.argmin(np.abs(x_mm - spot['x_mm'])))
            cy = int(np.argmin(np.abs(y_mm - spot['y_mm'])))
            powers.append(np.sum(intensity[cy - 2:cy + 3, cx - 2:cx + 3]))
        self.assertGreater(powers[1] / powers[0], 1.3)

    def test_equal_weights_remain_equal_for_nonuniform_spacing(self):
        width = height = 512
        pixel_size_um = self.PIXEL_SIZE_UM
        focal_length_mm = self.FOCAL_LENGTH_MM
        wavelength_nm = self.WAVELENGTH_NM
        output_step = wavelength_nm / 1e6 * focal_length_mm / (
            width * pixel_size_um / 1000
        )
        spots = [
            {'x_mm': 0, 'y_mm': 0, 'weight': 1},
            {'x_mm': 4 * output_step, 'y_mm': 0, 'weight': 1},
            {'x_mm': 0, 'y_mm': 12 * output_step, 'weight': 1}
        ]
        phase = SLMPatternGenerator.fresnel_three_spots(
            width=width,
            height=height,
            focal_length=focal_length_mm,
            wavelength=wavelength_nm,
            pixel_size_um=pixel_size_um,
            incident_beam_diameter_mm=self.BEAM_DIAMETER_MM,
            iterations=60,
            algorithm='gaussian_wgs',
            with_lens=False,
            target_spots=spots
        )
        x = (np.arange(width) - width // 2) * pixel_size_um / 1000
        y = (np.arange(height) - height // 2) * pixel_size_um / 1000
        X, Y = np.meshgrid(x, y)
        illumination = np.exp(
            -(X**2 + Y**2) / (self.BEAM_DIAMETER_MM / 2) ** 2
        )
        intensity = np.abs(np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(
            illumination * np.exp(1j * phase.astype(float) / 255 * 2 * np.pi)
        )))) ** 2
        coords = (np.arange(width) - width // 2) * output_step
        waist = max(
            wavelength_nm / 1e6 * focal_length_mm /
            (np.pi * (self.BEAM_DIAMETER_MM / 2)),
            0.8 * output_step
        )
        roi_radius = min(
            2.5 * waist,
            0.45 * min(
                np.hypot(a['x_mm'] - b['x_mm'], a['y_mm'] - b['y_mm'])
                for i, a in enumerate(spots)
                for b in spots[i + 1:]
            )
        )
        powers = []
        for spot in spots:
            cx = int(np.argmin(np.abs(coords - spot['x_mm'])))
            cy = int(np.argmin(np.abs(coords - spot['y_mm'])))
            radius = int(np.ceil(roi_radius / output_step))
            y0, y1 = max(0, cy - radius), min(height, cy + radius + 1)
            x0, x1 = max(0, cx - radius), min(width, cx + radius + 1)
            local_x, local_y = np.meshgrid(coords[x0:x1], coords[y0:y1])
            mask = (
                (local_x - spot['x_mm']) ** 2 +
                (local_y - spot['y_mm']) ** 2
            ) <= roi_radius**2
            powers.append(np.sum(intensity[y0:y1, x0:x1][mask]))
        self.assertLess(max(powers) / min(powers), 1.35, powers)

    def test_invalid_target_spots_are_rejected(self):
        invalid_sets = [
            ([{'x_mm': 0, 'y_mm': 0}, {'x_mm': 1}], '光斑坐标'),
            ([{'x_mm': 0, 'y_mm': 0}, {'x_mm': 0, 'y_mm': 0}], '重叠'),
            ([{'x_mm': 0, 'y_mm': 0}, {'x_mm': 100, 'y_mm': 0}], '范围'),
            ([{'x_mm': 0, 'y_mm': 0}, {'x_mm': 1, 'y_mm': 1, 'weight': 0}], '权重'),
            ([{'x_mm': 0, 'y_mm': 0}, {'x_mm': 0.1, 'y_mm': 0.1}], '可分辨')
        ]
        for spots, message in invalid_sets:
            with self.subTest(spots=spots), self.assertRaisesRegex(ValueError, message):
                self._generate(spots)

    def test_target_on_focal_plane_edge_margin_is_rejected(self):
        _, _, output_step = self._output_grid()
        output_half_width = 127 * output_step
        minimum_waist = 0.8 * output_step
        edge_position = output_half_width - 2.5 * minimum_waist

        with self.assertRaisesRegex(ValueError, '边缘超出'):
            self._generate([
                {'x_mm': 0, 'y_mm': 0},
                {'x_mm': edge_position, 'y_mm': 0}
            ])

    def test_uniform_grating_accepts_custom_two_dimensional_positions(self):
        phase = SLMPatternGenerator.fresnel_three_spots(
            width=64,
            height=64,
            focal_length=self.FOCAL_LENGTH_MM,
            wavelength=self.WAVELENGTH_NM,
            pixel_size_um=self.PIXEL_SIZE_UM,
            target_spots=[
                {'x_mm': -1, 'y_mm': -0.5},
                {'x_mm': 1, 'y_mm': 0.5}
            ],
            algorithm='uniform_grating'
        )
        self.assertEqual(phase.shape, (64, 64))

    def test_custom_wgs_rejects_excessive_computation(self):
        spots = [
            {'x_mm': -1, 'y_mm': 0},
            {'x_mm': 1, 'y_mm': 0}
        ]
        with self.assertRaisesRegex(ValueError, '计算量过大'):
            SLMPatternGenerator.fresnel_three_spots(
                width=2048,
                height=1024,
                focal_length=1000,
                wavelength=532,
                pixel_size_um=self.PIXEL_SIZE_UM,
                algorithm='gaussian_wgs',
                iterations=200,
                target_spots=spots
            )

    def test_api_accepts_and_reports_custom_positions_without_writing_user_state(self):
        payload = {
            'focal_length': self.FOCAL_LENGTH_MM,
            'wavelength': self.WAVELENGTH_NM,
            'pixel_size_um': self.PIXEL_SIZE_UM,
            'incident_beam_diameter_mm': self.BEAM_DIAMETER_MM,
            'algorithm': 'gaussian_wgs',
            'iterations': 3,
            'width': 128,
            'height': 128,
            'target_spots': [
                {'x_mm': -3, 'y_mm': -2, 'weight': 1},
                {'x_mm': 3, 'y_mm': 2, 'weight': 1.5}
            ]
        }
        with tempfile.TemporaryDirectory() as output_dir, \
                patch.object(web_app, 'OUTPUT_DIR', output_dir), \
                patch.object(web_app.db.session, 'add'), \
                patch.object(web_app.db.session, 'commit'):
            response = web_app.app.test_client().post(
                '/api/generate/fresnel_three_spots', json=payload
            )
        self.assertEqual(response.status_code, 200, response.get_json())
        result = response.get_json()
        self.assertTrue(result['success'])
        self.assertEqual(result['target_spots'], payload['target_spots'])
        self.assertIn('_n2_', result['filename'])

    def test_default_api_request_keeps_the_legacy_response(self):
        payload = {
            'focal_length': self.FOCAL_LENGTH_MM,
            'wavelength': self.WAVELENGTH_NM,
            'spot_spacing': 1,
            'spot_count': 3,
            'pixel_size_um': self.PIXEL_SIZE_UM,
            'algorithm': 'uniform_grating',
            'width': 128,
            'height': 128
        }
        with tempfile.TemporaryDirectory() as output_dir, \
                patch.object(web_app, 'OUTPUT_DIR', output_dir), \
                patch.object(web_app.db.session, 'add'), \
                patch.object(web_app.db.session, 'commit'):
            response = web_app.app.test_client().post(
                '/api/generate/fresnel_three_spots', json=payload
            )
        self.assertEqual(response.status_code, 200, response.get_json())
        result = response.get_json()
        self.assertTrue(result['success'])
        self.assertIn('image', result)
        self.assertNotIn('target_spots', result)

    def test_no_lens_custom_filename_uses_custom_spot_count(self):
        payload = {
            'focal_length': self.FOCAL_LENGTH_MM,
            'wavelength': self.WAVELENGTH_NM,
            'pixel_size_um': self.PIXEL_SIZE_UM,
            'incident_beam_diameter_mm': self.BEAM_DIAMETER_MM,
            'algorithm': 'gaussian_wgs',
            'iterations': 3,
            'width': 128,
            'height': 128,
            'target_spots': [
                {'x_mm': -3, 'y_mm': -2, 'weight': 1},
                {'x_mm': 3, 'y_mm': 2, 'weight': 1.5}
            ]
        }
        with tempfile.TemporaryDirectory() as output_dir, \
                patch.object(web_app, 'OUTPUT_DIR', output_dir), \
                patch.object(web_app.db.session, 'add'), \
                patch.object(web_app.db.session, 'commit'):
            response = web_app.app.test_client().post(
                '/api/generate/three_spots', json=payload
            )
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertIn('_n2_', response.get_json()['filename'])


if __name__ == '__main__':
    unittest.main()
