"""Regression tests for the Gaussian three-spot Fresnel hologram."""

import unittest

import numpy as np

from app import SLMPatternGenerator


class FresnelThreeSpotTests(unittest.TestCase):
    WIDTH = 512
    HEIGHT = 512
    PITCH_UM = 12.5
    WAVELENGTH_NM = 532
    FOCAL_LENGTH_MM = 1000
    SPACING_MM = 1.0
    BEAM_DIAMETER_MM = 5.0

    @classmethod
    def setUpClass(cls):
        cls.pattern = SLMPatternGenerator.fresnel_three_spots(
            width=cls.WIDTH,
            height=cls.HEIGHT,
            focal_length=cls.FOCAL_LENGTH_MM,
            wavelength=cls.WAVELENGTH_NM,
            spot_spacing=cls.SPACING_MM,
            pixel_size_um=cls.PITCH_UM,
            algorithm='gaussian_wgs',
            incident_beam_diameter_mm=cls.BEAM_DIAMETER_MM,
            iterations=30
        )

    def _focal_intensity(self):
        wavelength_mm = self.WAVELENGTH_NM / 1e6
        pixel_size_mm = self.PITCH_UM / 1000
        x = (
            np.arange(self.WIDTH) - (self.WIDTH - 1) / 2
        ) * pixel_size_mm
        y = (
            np.arange(self.HEIGHT) - (self.HEIGHT - 1) / 2
        ) * pixel_size_mm
        X, Y = np.meshgrid(x, y)
        lens_phase = -np.pi * (X**2 + Y**2) / (
            wavelength_mm * self.FOCAL_LENGTH_MM
        )
        quantized_phase = self.pattern.astype(float) / 255 * 2 * np.pi
        hologram_phase = np.angle(
            np.exp(1j * (quantized_phase - lens_phase))
        )
        beam_radius = self.BEAM_DIAMETER_MM / 2
        illumination = np.exp(-(X**2 + Y**2) / beam_radius**2)
        field = illumination * np.exp(1j * hologram_phase)
        focal_field = np.fft.fftshift(
            np.fft.fft2(np.fft.ifftshift(field))
        )
        return np.abs(focal_field) ** 2

    def test_gaussian_spots_are_center_bright_and_equal_power(self):
        intensity = self._focal_intensity()
        wavelength_mm = self.WAVELENGTH_NM / 1e6
        pixel_size_mm = self.PITCH_UM / 1000
        output_step = wavelength_mm * self.FOCAL_LENGTH_MM / (
            self.WIDTH * pixel_size_mm
        )
        output_x = (
            np.arange(self.WIDTH) - self.WIDTH // 2
        ) * output_step
        output_y = (
            np.arange(self.HEIGHT) - self.HEIGHT // 2
        ) * output_step
        X, Y = np.meshgrid(output_x, output_y)
        waist = max(
            wavelength_mm * self.FOCAL_LENGTH_MM /
            (np.pi * self.BEAM_DIAMETER_MM / 2),
            0.8 * output_step
        )

        powers = []
        center_ratios = []
        center_y = self.HEIGHT // 2
        for target_x in (-self.SPACING_MM, 0.0, self.SPACING_MM):
            mask = (X - target_x) ** 2 + Y**2 <= (2.5 * waist) ** 2
            powers.append(np.sum(intensity[mask]))
            center_x = np.argmin(np.abs(output_x - target_x))
            neighbors = np.mean([
                intensity[center_y - 1, center_x],
                intensity[center_y + 1, center_x],
                intensity[center_y, center_x - 1],
                intensity[center_y, center_x + 1]
            ])
            center_ratios.append(intensity[center_y, center_x] / neighbors)

        relative_power = np.array(powers) / max(powers)
        self.assertGreater(relative_power.min(), 0.97)
        self.assertGreater(min(center_ratios), 5.0)

    def test_inverted_direction_negates_phase(self):
        inverted = SLMPatternGenerator.fresnel_three_spots(
            width=self.WIDTH,
            height=self.HEIGHT,
            focal_length=self.FOCAL_LENGTH_MM,
            wavelength=self.WAVELENGTH_NM,
            spot_spacing=self.SPACING_MM,
            pixel_size_um=self.PITCH_UM,
            algorithm='gaussian_wgs',
            incident_beam_diameter_mm=self.BEAM_DIAMETER_MM,
            iterations=30,
            phase_direction='inverted'
        )
        phase_sum = (self.pattern.astype(int) + inverted.astype(int)) % 255
        self.assertTrue(np.all(phase_sum == 0))

    def test_dammann_orders_are_equal_and_center_bright(self):
        pattern = SLMPatternGenerator.fresnel_three_spots(
            width=self.WIDTH,
            height=self.HEIGHT,
            focal_length=self.FOCAL_LENGTH_MM,
            wavelength=self.WAVELENGTH_NM,
            spot_spacing=self.SPACING_MM,
            pixel_size_um=self.PITCH_UM,
            algorithm='dammann',
            incident_beam_diameter_mm=self.BEAM_DIAMETER_MM
        )
        wavelength_mm = self.WAVELENGTH_NM / 1e6
        pixel_size_mm = self.PITCH_UM / 1000
        x = (
            np.arange(self.WIDTH) - (self.WIDTH - 1) / 2
        ) * pixel_size_mm
        X, Y = np.meshgrid(x, x)
        lens_phase = -np.pi * (X**2 + Y**2) / (
            wavelength_mm * self.FOCAL_LENGTH_MM
        )
        phase = pattern.astype(float) / 255 * 2 * np.pi
        grating_phase = np.angle(np.exp(1j * (phase - lens_phase)))
        illumination = np.exp(
            -(X**2 + Y**2) / (self.BEAM_DIAMETER_MM / 2) ** 2
        )
        field = illumination * np.exp(1j * grating_phase)
        focal_field = np.fft.fftshift(
            np.fft.fft2(np.fft.ifftshift(field))
        )
        intensity = np.abs(focal_field) ** 2
        output_step = wavelength_mm * self.FOCAL_LENGTH_MM / (
            self.WIDTH * pixel_size_mm
        )
        output_x = (
            np.arange(self.WIDTH) - self.WIDTH // 2
        ) * output_step
        center_y = self.HEIGHT // 2
        peaks = [
            intensity[center_y, np.argmin(np.abs(output_x - target_x))]
            for target_x in (-self.SPACING_MM, 0.0, self.SPACING_MM)
        ]
        relative_peaks = np.array(peaks) / max(peaks)
        self.assertGreater(relative_peaks.min(), 0.98)

    def test_custom_count_is_uniform_for_different_beam_sizes(self):
        spot_count = 5
        pattern = SLMPatternGenerator.fresnel_three_spots(
            width=self.WIDTH,
            height=self.HEIGHT,
            focal_length=self.FOCAL_LENGTH_MM,
            wavelength=self.WAVELENGTH_NM,
            spot_spacing=self.SPACING_MM,
            spot_count=spot_count,
            pixel_size_um=self.PITCH_UM,
            algorithm='uniform_grating'
        )
        wavelength_mm = self.WAVELENGTH_NM / 1e6
        pixel_size_mm = self.PITCH_UM / 1000
        x = (
            np.arange(self.WIDTH) - (self.WIDTH - 1) / 2
        ) * pixel_size_mm
        X, Y = np.meshgrid(x, x)
        lens_phase = -np.pi * (X**2 + Y**2) / (
            wavelength_mm * self.FOCAL_LENGTH_MM
        )
        phase = pattern.astype(float) / 255 * 2 * np.pi
        grating_phase = np.angle(np.exp(1j * (phase - lens_phase)))

        output_step = wavelength_mm * self.FOCAL_LENGTH_MM / (
            self.WIDTH * pixel_size_mm
        )
        cycles = round(self.SPACING_MM / output_step)
        actual_spacing = cycles * output_step
        target_positions = (
            np.arange(spot_count) - (spot_count - 1) / 2
        ) * actual_spacing
        output_x = (
            np.arange(self.WIDTH) - self.WIDTH // 2
        ) * output_step
        center_y = self.HEIGHT // 2

        for beam_diameter in (3.0, 7.0):
            illumination = np.exp(
                -(X**2 + Y**2) / (beam_diameter / 2) ** 2
            )
            focal_field = np.fft.fftshift(
                np.fft.fft2(
                    np.fft.ifftshift(
                        illumination * np.exp(1j * grating_phase)
                    )
                )
            )
            intensity = np.abs(focal_field) ** 2
            patches = []
            powers = []
            for target_x in target_positions:
                center_x = int(np.argmin(np.abs(output_x - target_x)))
                patch = intensity[
                    center_y - 3:center_y + 4,
                    center_x - 3:center_x + 4
                ]
                patches.append(patch / np.max(patch))
                powers.append(np.sum(patch))

            relative_power = np.array(powers) / max(powers)
            self.assertGreater(relative_power.min(), 0.97)
            reference = patches[spot_count // 2]
            for patch in patches:
                self.assertLess(np.max(np.abs(patch - reference)), 0.08)

    def test_equal_order_cells_cover_all_supported_counts(self):
        for spot_count in range(2, 16):
            phase = SLMPatternGenerator._design_equal_order_phase_cell(
                spot_count
            )
            base_samples = 64
            orders = np.arange(spot_count) - (spot_count - 1) / 2
            target_bins = np.mod(
                np.rint(orders * len(phase) / base_samples).astype(int),
                len(phase)
            )
            spectrum = np.fft.fft(np.exp(1j * phase)) / len(phase)
            intensities = np.abs(spectrum[target_bins]) ** 2
            uniformity = np.min(intensities) / np.max(intensities)
            self.assertGreater(
                uniformity,
                0.99,
                msg=f'光斑数量 {spot_count} 的光栅级次不均匀'
            )

    def test_even_count_is_aligned_to_simulation_pixels(self):
        spot_count = 4
        pattern = SLMPatternGenerator.fresnel_three_spots(
            width=self.WIDTH,
            height=self.HEIGHT,
            focal_length=self.FOCAL_LENGTH_MM,
            wavelength=self.WAVELENGTH_NM,
            spot_spacing=self.SPACING_MM,
            spot_count=spot_count,
            pixel_size_um=self.PITCH_UM,
            algorithm='uniform_grating'
        )
        self.assertEqual(pattern.shape, (self.HEIGHT, self.WIDTH))
        output_step = (
            self.WAVELENGTH_NM / 1e6 * self.FOCAL_LENGTH_MM /
            (self.WIDTH * self.PITCH_UM / 1000)
        )
        cycles = round(self.SPACING_MM / output_step)
        self.assertEqual(cycles % 2, 0)

    def test_gaussian_wgs_accepts_explicit_spot_radius(self):
        patterns = [
            SLMPatternGenerator.fresnel_three_spots(
                width=self.WIDTH,
                height=self.HEIGHT,
                focal_length=self.FOCAL_LENGTH_MM,
                wavelength=self.WAVELENGTH_NM,
                spot_spacing=self.SPACING_MM,
                pixel_size_um=self.PITCH_UM,
                algorithm='gaussian_wgs',
                incident_beam_diameter_mm=self.BEAM_DIAMETER_MM,
                iterations=5,
                with_lens=False,
                spot_radius_mm=radius
            )
            for radius in (0.15, 0.25)
        ]
        self.assertFalse(np.array_equal(*patterns))

    def test_gaussian_wgs_rejects_unresolvable_spot_radius(self):
        with self.assertRaisesRegex(ValueError, '采样下限'):
            SLMPatternGenerator.fresnel_three_spots(
                width=self.WIDTH,
                height=self.HEIGHT,
                focal_length=self.FOCAL_LENGTH_MM,
                wavelength=self.WAVELENGTH_NM,
                spot_spacing=self.SPACING_MM,
                pixel_size_um=self.PITCH_UM,
                algorithm='gaussian_wgs',
                with_lens=False,
                spot_radius_mm=0.01
            )

    def test_dammann_rejects_non_three_count(self):
        with self.assertRaisesRegex(ValueError, '仅支持 3'):
            SLMPatternGenerator.fresnel_three_spots(
                spot_count=5,
                algorithm='dammann'
            )

    def test_invalid_optimization_parameters_are_rejected(self):
        with self.assertRaisesRegex(ValueError, '光斑数量'):
            SLMPatternGenerator.fresnel_three_spots(spot_count=16)
        with self.assertRaisesRegex(ValueError, '直径'):
            SLMPatternGenerator.fresnel_three_spots(
                algorithm='gaussian_wgs',
                incident_beam_diameter_mm=0
            )
        with self.assertRaisesRegex(ValueError, '迭代次数'):
            SLMPatternGenerator.fresnel_three_spots(
                algorithm='gaussian_wgs',
                iterations=0
            )


if __name__ == '__main__':
    unittest.main()
