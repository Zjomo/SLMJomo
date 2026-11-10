"""
Flask Web应用 - 菲涅尔透镜相位图生成系统
支持图像输入和实时参数调整
"""

from flask import Flask, render_template, request, jsonify, send_file
from flask_sqlalchemy import SQLAlchemy
import numpy as np
from PIL import Image
import io
import base64
import os
from datetime import datetime
import json
from functools import lru_cache
from scipy import ndimage

# 创建Flask应用
app = Flask(__name__)
app.config['SECRET_KEY'] = 'fresnel_lens_secret_key_2026'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///fresnel_config.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# 输出目录（绝对路径，确保保存和下载路径一致）
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output_phase_patterns')
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 初始化数据库
db = SQLAlchemy(app)


# ==================== 数据库模型 ====================
class PresetConfig(db.Model):
    """参数预设配置表"""
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text)
    focus_mm = db.Column(db.Float, nullable=False)
    wavelength_nm = db.Column(db.Float, nullable=False)
    x_pixels = db.Column(db.Integer, default=1272)
    y_pixels = db.Column(db.Integer, default=1024)
    pitch_mode = db.Column(db.Integer, default=1)
    rotation_degree = db.Column(db.Float, default=0.0)
    offset_x = db.Column(db.Integer, default=0)
    offset_y = db.Column(db.Integer, default=0)
    scale_factor = db.Column(db.Float, default=1.0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'focus_mm': self.focus_mm,
            'wavelength_nm': self.wavelength_nm,
            'x_pixels': self.x_pixels,
            'y_pixels': self.y_pixels,
            'pitch_mode': self.pitch_mode,
            'rotation_degree': self.rotation_degree,
            'offset_x': self.offset_x,
            'offset_y': self.offset_y,
            'scale_factor': self.scale_factor,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'updated_at': self.updated_at.strftime('%Y-%m-%d %H:%M:%S')
        }


class GenerationHistory(db.Model):
    """生成历史记录表"""
    id = db.Column(db.Integer, primary_key=True)
    config_name = db.Column(db.String(100))
    focus_mm = db.Column(db.Float)
    wavelength_nm = db.Column(db.Float)
    input_image = db.Column(db.String(200))
    output_file = db.Column(db.String(200))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'config_name': self.config_name,
            'focus_mm': self.focus_mm,
            'wavelength_nm': self.wavelength_nm,
            'input_image': self.input_image,
            'output_file': self.output_file,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S')
        }


# ==================== SLM相位图生成核心 ====================
class SLMPatternGenerator:
    """
    SLM常见相位图统一生成器
    参考 matlab_SLM_功能模块参考代码 中的MATLAB实现
    """

    @staticmethod
    def array_to_base64(array):
        """将numpy数组转换为base64 PNG字符串（仅用于预览）"""
        # 统一转换为 uint8 灰度
        if array.dtype != np.uint8:
            array = np.clip(array, 0, 1) if array.max() <= 1.0 else np.clip(array, 0, 255)
            array = (array * 255 if array.max() <= 1.0 else array).astype(np.uint8)
        img = Image.fromarray(array, mode='L')
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)
        img_base64 = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/png;base64,{img_base64}"

    @staticmethod
    def save_image(array, filepath):
        """保存图像到文件，强制为 8-bit BMP"""
        # 统一转换为 uint8 灰度
        if array.dtype != np.uint8:
            array = np.clip(array, 0, 1) if array.max() <= 1.0 else np.clip(array, 0, 255)
            array = (array * 255 if array.max() <= 1.0 else array).astype(np.uint8)
        img = Image.fromarray(array, mode='L')
        img.save(filepath, format='BMP')

    @staticmethod
    def _create_coordinate_grid(width, height, offset_x=0, offset_y=0, scale=1.0, rotate=0.0):
        """创建坐标网格，支持偏移、缩放和旋转"""
        x = (np.arange(width) - width / 2 + offset_x) / scale
        y = (np.arange(height) - height / 2 + offset_y) / scale
        X, Y = np.meshgrid(x, y)

        if rotate != 0:
            theta = np.radians(rotate)
            X_rot = X * np.cos(theta) - Y * np.sin(theta)
            Y_rot = X * np.sin(theta) + Y * np.cos(theta)
            X, Y = X_rot, Y_rot

        return X, Y

    # ------------------- 1. 菲涅尔透镜 -------------------
    @staticmethod
    def fresnel_lens(
        width=1272,
        height=1024,
        focal_length=1000,
        wavelength=532,
        pixel_size=12.5e-3,  # Hamamatsu X15223: 12.5 um (LEJ-B60004-4)
        **kwargs
    ):
        """
        菲涅尔透镜相位图
        参考: fresnellens.m

        参数:
            focal_length: 焦距（mm），正数为会聚，负数为发散
            wavelength: 波长（nm）
            pixel_size: 像素尺寸（mm），默认12.5μm
        """
        wavelength_mm = wavelength / 1e6  # nm -> mm

        # 坐标网格
        x = np.arange(width) - width / 2
        y = np.arange(height) - height / 2
        X, Y = np.meshgrid(x, y)
        R_sq = X**2 + Y**2

        # 镜面方程
        R = 2 * abs(focal_length)
        mirror = R - np.sqrt(np.maximum(R**2 - R_sq * pixel_size**2, 0))
        mirror = np.max(mirror) - mirror

        # 转换为相位
        phase = mirror / wavelength_mm * 2 * np.pi
        phase = np.mod(phase, 2 * np.pi)
        phase = phase / (2 * np.pi) * 255

        # 焦距为正时取反（会聚透镜）
        if focal_length > 0:
            phase = 255 - phase

        return phase.astype(np.uint8)

    # ------------------- 1b. 柱面透镜 -------------------
    @staticmethod
    def cylindrical_lens(
        width=1272,
        height=1024,
        focal_length=1000,
        wavelength=532,
        pixel_size=25e-3,
        angle=0,
        **kwargs
    ):
        """
        柱面透镜相位图：单轴二次相位，产生焦线
        参考: fresnellens.m 的一维形式

        参数:
            focal_length: 焦距（mm），正数为会聚，负数为发散
            wavelength: 波长（nm）
            pixel_size: 像素尺寸（mm），默认25μm
            angle: 柱面轴旋转角（°），0=沿x轴聚焦
        """
        wavelength_mm = wavelength / 1e6  # nm -> mm

        # 坐标网格
        x = np.arange(width) - width / 2
        y = np.arange(height) - height / 2
        X, Y = np.meshgrid(x, y)

        # 旋转坐标以控制柱面轴向
        theta = np.radians(angle)
        X_rot = X * np.cos(theta) + Y * np.sin(theta)

        # 一维二次相位（抛物线近似）
        phase = -np.pi * (X_rot * pixel_size) ** 2 / (wavelength_mm * focal_length)
        phase = np.mod(phase, 2 * np.pi)
        phase = phase / (2 * np.pi) * 255

        # 焦距为正时取反（会聚透镜）
        if focal_length > 0:
            phase = 255 - phase

        return phase.astype(np.uint8)

    @staticmethod
    def fresnel_three_spots(
        width=1272,
        height=1024,
        focal_length=1000,
        wavelength=532,
        spot_spacing=1.0,
        spot_count=3,
        pixel_size_um=12.5,
        algorithm='analytic',
        incident_beam_diameter_mm=10.0,
        iterations=30,
        phase_direction='standard',
        with_lens=True,
        spot_radius_mm=None,
        **kwargs
    ):
        """Generate a phase-only Fresnel hologram for three horizontal focal spots.

        The target points are located at (-d, 0), (0, 0), and (+d, 0) in
        the focal plane. Analytic, binary Dammann, and weighted-GS encodings
        are supported.
        All physical distances are expressed in millimetres except wavelength
        and pixel_size_um.

        with_lens=False 时去掉透镜相位项，仅生成分束光栅
        （配合外部光学系统或远场衍射使用）。
        """
        if focal_length <= 0:
            raise ValueError("焦距必须大于 0 mm")
        if wavelength <= 0:
            raise ValueError("波长必须大于 0 nm")
        if spot_spacing <= 0:
            raise ValueError("点间距必须大于 0 mm")
        if not 2 <= spot_count <= 15:
            raise ValueError("光斑数量必须在 2 到 15 之间")
        if pixel_size_um <= 0:
            raise ValueError("像素尺寸必须大于 0 um")
        if algorithm not in (
            'analytic', 'dammann', 'uniform_grating', 'gaussian_wgs'
        ):
            raise ValueError(
                "算法必须是 analytic、dammann、uniform_grating 或 "
                "gaussian_wgs"
            )
        if phase_direction not in ('standard', 'inverted'):
            raise ValueError("相位方向必须是 standard 或 inverted")
        if incident_beam_diameter_mm <= 0:
            raise ValueError("入射高斯光束直径必须大于 0 mm")
        if not 1 <= iterations <= 200:
            raise ValueError("迭代次数必须在 1 到 200 之间")
        if algorithm == 'gaussian_wgs' and width * height > 2_500_000:
            raise ValueError("高斯优化分辨率不得超过 250 万像素")

        wavelength_mm = wavelength / 1e6
        pixel_size_mm = pixel_size_um / 1000
        k = 2 * np.pi / wavelength_mm

        x = (np.arange(width) - (width - 1) / 2) * pixel_size_mm
        y = (np.arange(height) - (height - 1) / 2) * pixel_size_mm
        X, Y = np.meshgrid(x, y)

        if algorithm == 'gaussian_wgs':
            phase = SLMPatternGenerator._gaussian_spot_array_wgs(
                X=X,
                Y=Y,
                width=width,
                height=height,
                focal_length=focal_length,
                wavelength_mm=wavelength_mm,
                pixel_size_mm=pixel_size_mm,
                spot_spacing=spot_spacing,
                spot_count=spot_count,
                incident_beam_diameter_mm=incident_beam_diameter_mm,
                iterations=iterations,
                with_lens=with_lens,
                spot_radius_mm=spot_radius_mm
            )
        elif algorithm == 'uniform_grating':
            phase = SLMPatternGenerator._uniform_spot_grating_phase(
                X=X,
                Y=Y,
                focal_length=focal_length,
                wavelength_mm=wavelength_mm,
                pixel_size_mm=pixel_size_mm,
                spot_spacing=spot_spacing,
                spot_count=spot_count,
                with_lens=with_lens
            )
        elif algorithm == 'dammann':
            if spot_count != 3:
                raise ValueError("1x3 达曼光栅仅支持 3 个光斑")
            phase = SLMPatternGenerator._dammann_three_spot_phase(
                X=X,
                Y=Y,
                focal_length=focal_length,
                wavelength_mm=wavelength_mm,
                pixel_size_mm=pixel_size_mm,
                spot_spacing=spot_spacing,
                incident_beam_diameter_mm=incident_beam_diameter_mm,
                with_lens=with_lens
            )
        else:
            field = np.zeros((height, width), dtype=np.complex128)
            target_positions = (
                np.arange(spot_count) - (spot_count - 1) / 2
            ) * spot_spacing
            target_weights = np.ones(spot_count)
            if spot_count == 3:
                target_weights[1] = 1.085
            if with_lens:
                for target_x, weight in zip(target_positions, target_weights):
                    optical_path = np.sqrt(
                        (X - target_x) ** 2 + Y ** 2 + focal_length ** 2
                    )
                    field += weight * np.exp(
                        -1j * k * (optical_path - focal_length)
                    )
            else:
                # 无透镜：抛物线近似的远场分束（纯线性相位光栅）
                for target_x, weight in zip(target_positions, target_weights):
                    field += weight * np.exp(
                        1j * k * X * target_x / focal_length
                    )
            phase = np.angle(field)

        if phase_direction == 'inverted':
            phase = -phase

        phase = np.mod(phase, 2 * np.pi)
        return np.rint(phase / (2 * np.pi) * 255).astype(np.uint8)

    @staticmethod
    def _uniform_spot_grating_phase(
        X,
        Y,
        focal_length,
        wavelength_mm,
        pixel_size_mm,
        spot_spacing,
        spot_count,
        with_lens=True
    ):
        """Replicate an input beam into equal consecutive diffraction orders."""
        width = X.shape[1]
        output_step = wavelength_mm * focal_length / (width * pixel_size_mm)
        cycles = max(1, int(round(spot_spacing / output_step)))
        if spot_count % 2 == 0 and cycles % 2:
            candidates = [value for value in (cycles - 1, cycles + 1) if value >= 2]
            cycles = min(
                candidates,
                key=lambda value: abs(value * output_step - spot_spacing)
            )

        max_order = (spot_count - 1) / 2
        if max_order * cycles >= width / 2:
            raise ValueError(
                "光斑数量与点间距超过 SLMControl3 傅里叶采样范围；"
                "请减少光斑数量或点间距"
            )

        cell_phase = SLMPatternGenerator._design_equal_order_phase_cell(
            spot_count
        )
        column = np.arange(width) - (width - 1) / 2
        if spot_count % 2:
            cell_coordinate = np.mod(cycles * column / width, 1.0)
        else:
            cell_coordinate = np.mod(cycles * column / (2 * width), 1.0)
        cell_index = np.floor(cell_coordinate * len(cell_phase)).astype(int)
        grating_phase = cell_phase[cell_index][np.newaxis, :]
        if not with_lens:
            return np.broadcast_to(grating_phase, X.shape)
        lens_phase = -np.pi * (X**2 + Y**2) / (
            wavelength_mm * focal_length
        )
        return lens_phase + grating_phase

    @staticmethod
    @lru_cache(maxsize=16)
    def _design_equal_order_phase_cell(spot_count):
        """Design a deterministic multilevel phase cell with equal orders."""
        base_samples = 64
        cell_samples = base_samples if spot_count % 2 else 2 * base_samples
        orders = np.arange(spot_count) - (spot_count - 1) / 2
        target_bins = np.mod(
            np.rint(orders * cell_samples / base_samples).astype(int),
            cell_samples
        )

        if spot_count == 2:
            index = np.arange(cell_samples)
            return np.where(index < cell_samples / 2, 0.0, np.pi)

        best_score = -np.inf
        best_phase = None
        for restart in range(16):
            rng = np.random.default_rng(1000 * spot_count + restart)
            weights = np.ones(spot_count)
            constrained = np.zeros(cell_samples, dtype=np.complex128)
            constrained[target_bins] = np.exp(
                1j * rng.uniform(0, 2 * np.pi, spot_count)
            )
            phase = np.angle(np.fft.ifft(constrained))

            for _ in range(200):
                spectrum = np.fft.fft(np.exp(1j * phase)) / cell_samples
                amplitudes = np.abs(spectrum[target_bins])
                weights *= np.mean(amplitudes) / np.maximum(amplitudes, 1e-12)
                weights /= np.mean(weights)
                constrained.fill(0)
                constrained[target_bins] = weights * np.exp(
                    1j * np.angle(spectrum[target_bins])
                )
                phase = np.angle(np.fft.ifft(constrained))

            spectrum = np.fft.fft(np.exp(1j * phase)) / cell_samples
            intensities = np.abs(spectrum[target_bins]) ** 2
            uniformity = np.min(intensities) / np.max(intensities)
            efficiency = np.sum(intensities)
            score = uniformity + 0.02 * efficiency
            if score > best_score:
                best_score = score
                best_phase = phase.copy()

        best_phase.setflags(write=False)
        return best_phase

    @staticmethod
    def _dammann_three_spot_phase(
        X,
        Y,
        focal_length,
        wavelength_mm,
        pixel_size_mm,
        spot_spacing,
        incident_beam_diameter_mm,
        with_lens=True
    ):
        """Create an equal-order 1x3 binary Dammann grating plus a lens."""
        period_mm = wavelength_mm * focal_length / spot_spacing
        period_pixels = period_mm / pixel_size_mm
        width = X.shape[1]
        if period_pixels < 6:
            raise ValueError(
                f"达曼光栅周期仅 {period_pixels:g} 像素；请减小点间距，"
                "使周期至少达到 6 像素"
            )
        if period_pixels > width / 2:
            raise ValueError(
                f"达曼光栅周期为 {period_pixels:g} 像素；当前宽度内至少"
                "需要容纳两个周期，请增大点间距"
            )

        # Solves |c0| = |c1| for a binary 0/pi grating. A one-third
        # inverted region would make the +/-1 orders about 2.74x brighter
        # than the zero order, so it is intentionally not used here.
        inverted_fraction = 0.26474189536599696
        x = X[0]
        beam_radius = incident_beam_diameter_mm / 2
        illumination_x = np.exp(-(x**2) / beam_radius**2)
        first_order_basis = np.exp(-2j * np.pi * x / period_mm)

        # Register the binary transitions against the physical pixel grid.
        # This removes the residual imbalance caused by sampled edge positions.
        best_error = np.inf
        best_binary_row = None
        for offset in np.linspace(0, 1, 256, endpoint=False):
            local_coordinate = np.mod(x / period_mm + offset + 0.5, 1) - 0.5
            binary_row = np.abs(local_coordinate) < inverted_fraction / 2
            signed_row = np.where(binary_row, -1.0, 1.0)
            zero_amplitude = abs(np.sum(illumination_x * signed_row))
            first_amplitude = abs(np.sum(
                illumination_x * signed_row * first_order_basis
            ))
            error = abs(zero_amplitude - first_amplitude)
            if error < best_error:
                best_error = error
                best_binary_row = binary_row

        grating_phase = np.where(best_binary_row[np.newaxis, :], np.pi, 0.0)
        if not with_lens:
            return np.broadcast_to(grating_phase, X.shape)
        lens_phase = -np.pi * (X**2 + Y**2) / (
            wavelength_mm * focal_length
        )
        return lens_phase + grating_phase

    @staticmethod
    def _gaussian_spot_array_wgs(
        X,
        Y,
        width,
        height,
        focal_length,
        wavelength_mm,
        pixel_size_mm,
        spot_spacing,
        spot_count,
        incident_beam_diameter_mm,
        iterations,
        with_lens=True,
        spot_radius_mm=None
    ):
        """Optimize three equal-power Gaussian spots in the focal plane."""
        beam_radius = incident_beam_diameter_mm / 2
        illumination = np.exp(-(X**2 + Y**2) / beam_radius**2)

        output_dx = wavelength_mm * focal_length / (width * pixel_size_mm)
        output_dy = wavelength_mm * focal_length / (height * pixel_size_mm)
        output_x = (np.arange(width) - width // 2) * output_dx
        output_y = (np.arange(height) - height // 2) * output_dy
        target_x, target_y = np.meshgrid(output_x, output_y)

        output_half_width = min(abs(output_x[0]), abs(output_x[-1]))
        target_positions = (
            np.arange(spot_count) - (spot_count - 1) / 2
        ) * spot_spacing
        if np.max(np.abs(target_positions)) >= output_half_width:
            raise ValueError(
                "最外侧光斑超出当前参数可生成范围 "
                f"(< {output_half_width:g} mm)"
            )

        # 1/e^2 intensity waist at the focus, with a sampling floor so the
        # requested Gaussian is represented by the discrete Fourier grid.
        minimum_waist = 0.8 * max(output_dx, output_dy)
        if spot_radius_mm is None:
            target_waist = max(
                wavelength_mm * focal_length / (np.pi * beam_radius),
                minimum_waist
            )
        else:
            target_waist = float(spot_radius_mm)
            if not np.isfinite(target_waist) or target_waist <= 0:
                raise ValueError("指定光斑半径必须是大于 0 的有限数值")
            if target_waist < minimum_waist:
                raise ValueError(
                    f"指定光斑半径小于当前采样下限 {minimum_waist:g} mm"
                )
        if spot_spacing < 2 * target_waist:
            raise ValueError(
                f"点间距过小，当前参数至少需要 {2 * target_waist:g} mm "
                "才能形成可分辨高斯点"
            )
        spot_profiles = [
            np.exp(
                -((target_x - x0) ** 2 + target_y**2) / target_waist**2
            ).astype(np.float32)
            for x0 in target_positions
        ]
        radius_x = max(1, int(np.ceil(2.5 * target_waist / output_dx)))
        radius_y = max(1, int(np.ceil(2.5 * target_waist / output_dy)))
        center_y = height // 2
        power_regions = []
        for x0 in target_positions:
            center_x = int(np.argmin(np.abs(output_x - x0)))
            power_regions.append((
                slice(
                    max(0, center_y - radius_y),
                    min(height, center_y + radius_y + 1)
                ),
                slice(
                    max(0, center_x - radius_x),
                    min(width, center_x + radius_x + 1)
                )
            ))

        weights = np.ones(spot_count, dtype=np.float64)
        target_amplitude = sum(spot_profiles)
        target_amplitude /= np.sqrt(np.sum(target_amplitude**2))
        back_field = np.fft.fftshift(
            np.fft.ifft2(np.fft.ifftshift(target_amplitude))
        )
        hologram_phase = np.angle(back_field)

        for _ in range(iterations):
            far_field = np.fft.fftshift(
                np.fft.fft2(
                    np.fft.ifftshift(
                        illumination * np.exp(1j * hologram_phase)
                    )
                )
            )
            intensity = np.abs(far_field) ** 2
            measured_power = np.array([
                np.sum(intensity[region]) for region in power_regions
            ])
            correction = np.sqrt(
                np.mean(measured_power) / np.maximum(measured_power, 1e-30)
            )
            weights *= correction**0.7
            weights /= np.mean(weights)

            target_amplitude = sum(
                weight * profile
                for weight, profile in zip(weights, spot_profiles)
            )
            target_amplitude /= np.sqrt(np.sum(target_amplitude**2))
            constrained_far_field = target_amplitude * np.exp(
                1j * np.angle(far_field)
            )
            back_field = np.fft.fftshift(
                np.fft.ifft2(np.fft.ifftshift(constrained_far_field))
            )
            hologram_phase = np.angle(back_field)

        if not with_lens:
            return hologram_phase
        lens_phase = -np.pi * (X**2 + Y**2) / (
            wavelength_mm * focal_length
        )
        return lens_phase + hologram_phase

    # ------------------- 2. 轴棱锥透镜 -------------------
    @staticmethod
    def axicon_lens(
        width=1272,
        height=1024,
        radius=100,
        **kwargs
    ):
        """
        轴棱锥透镜相位图
        参考: axicon.m
        产生贝塞尔光束

        参数:
            radius: 相位周期半径（像素）
        """
        x = np.arange(width) - width / 2
        y = np.arange(height) - height / 2
        X, Y = np.meshgrid(x, y)

        phase = -np.sqrt(X**2 + Y**2) * 2 * np.pi / radius
        phase = np.mod(phase, 2 * np.pi)
        phase = phase / np.max(phase) * 255

        return phase.astype(np.uint8)

    # ------------------- 3. 闪耀光栅 -------------------
    @staticmethod
    def blaze_grating(
        width=1272,
        height=1024,
        period=50,
        angle=0,
        **kwargs
    ):
        """
        闪耀光栅相位图
        参考: blazegrating.m

        参数:
            period: 光栅周期（像素）
            angle: 光栅旋转角度（°），顺时针
        """
        # 使用1-based坐标匹配MATLAB
        l = np.arange(1, width + 1)
        m = np.arange(1, height + 1)
        L, M = np.meshgrid(l, m)

        # 避免除零
        L_safe = np.where(L == 0, 1e-10, L)

        theta_local = np.arctan((M - 1) / (L_safe - 1)) - angle * np.pi / 180
        distance = np.sqrt((L - 1)**2 + (M - 1)**2)

        phase = np.mod(np.round(np.cos(theta_local) * distance), period)
        phase = phase * 255 * (period - 1) / period / np.max(phase + 1e-10)

        return phase.astype(np.uint8)

    # ------------------- 4. 正弦光栅 -------------------
    @staticmethod
    def sine_grating(
        width=1272,
        height=1024,
        period=50,
        angle=0,
        **kwargs
    ):
        """
        正弦光栅相位图
        参考: sinegrating.m

        参数:
            period: 光栅周期（像素）
            angle: 光栅旋转角度（°），顺时针
        """
        # 使用1-based坐标匹配MATLAB
        l = np.arange(1, width + 1)
        m = np.arange(1, height + 1)
        L, M = np.meshgrid(l, m)

        # 避免除零
        L_safe = np.where(L == 0, 1e-10, L)

        theta_local = np.arctan(M / L_safe) - angle * np.pi / 180
        distance = np.sqrt(L**2 + M**2)

        phase = 127.5 + 127.5 * np.sin(2 * np.pi / period * np.cos(theta_local) * distance)
        phase = np.clip(phase, 0, 255)

        return phase.astype(np.uint8)

    # ------------------- 5. 涡旋光束 -------------------
    @staticmethod
    def vortex_beam(
        width=512,
        height=512,
        lnumber=1,
        **kwargs
    ):
        """
        涡旋光束相位图
        参考: vortex.m
        产生轨道角动量光束

        参数:
            lnumber: 拓扑荷数
        """
        x = np.arange(width) - width / 2
        y = np.arange(height) - height / 2
        X, Y = np.meshgrid(x, y)

        # 计算0-2pi的角度
        angle = np.arctan2(Y, X)
        angle = np.where(angle < 0, angle + 2 * np.pi, angle)

        phase = np.mod(angle * lnumber, 2 * np.pi)
        phase = phase / (2 * np.pi) * 255

        return phase.astype(np.uint8)

    # ------------------- 6. 随机散斑 -------------------
    @staticmethod
    def random_image(
        width=512,
        height=512,
        seed=None,
        **kwargs
    ):
        """
        随机散斑相位图
        参考: randomimage.m

        参数:
            seed: 随机种子（可选，用于可重复）
        """
        if seed is not None:
            np.random.seed(int(seed))

        phase = np.random.rand(height, width) * 255

        if seed is not None:
            np.random.seed(None)  # 重置随机种子

        return phase.astype(np.uint8)

    # ------------------- 7. 分屏图案 -------------------
    @staticmethod
    def divide_screen(
        width=1272,
        height=1024,
        grayvalue1=0,
        grayvalue2=255,
        **kwargs
    ):
        """
        分屏图案
        参考: divide.m
        左半屏和右半屏不同灰度

        参数:
            grayvalue1: 左侧灰度值（0-255）
            grayvalue2: 右侧灰度值（0-255）
        """
        phase = np.zeros((height, width), dtype=np.uint8)
        phase[:, :width // 2] = int(grayvalue1)
        phase[:, width // 2:] = int(grayvalue2)

        return phase

    # ------------------- 8. 十字测试图 -------------------
    @staticmethod
    def cross_pattern(
        width=1024,
        height=768,
        background_phase=0.5,
        stripe_phase=0.0,
        stripe_width=12,
        stripe_spacing=28,
        stripe_number=3,
        intersection_phase=None,
        **kwargs
    ):
        """
        十字测试图（水平+垂直条纹交叉）
        参考: test.py 中的 generate_cross_phase

        参数:
            background_phase: 背景相位/灰度 (0-1，对应 0-2π)
            stripe_phase: 条纹相位/灰度 (0-1，对应 0-2π)
            stripe_width: 单条条纹宽度（像素）
            stripe_spacing: 条纹中心间距（像素）
            stripe_number: 条纹数量（建议奇数）
            intersection_phase: 交叉区域相位/灰度（可选，0-1）
        """
        # 输入参数为 0-1 范围的归一化相位，转换为弧度
        bg_rad = background_phase * 2 * np.pi
        stripe_rad = stripe_phase * 2 * np.pi
        intersect_rad = intersection_phase * 2 * np.pi if intersection_phase is not None else None

        # 初始化相位矩阵（弧度）
        phase = np.full((height, width), bg_rad, dtype=np.float64)

        center_x = width // 2
        center_y = height // 2
        index_list = np.arange(stripe_number) - (stripe_number - 1) / 2

        # 添加垂直条纹（沿 x 方向排列）
        for index in index_list:
            stripe_center = int(round(center_x + index * stripe_spacing))
            x_start = max(0, stripe_center - stripe_width // 2)
            x_end = min(width, stripe_center + stripe_width // 2 + 1)
            phase[:, x_start:x_end] = stripe_rad

        # 添加水平条纹（沿 y 方向排列）
        for index in index_list:
            stripe_center = int(round(center_y + index * stripe_spacing))
            y_start = max(0, stripe_center - stripe_width // 2)
            y_end = min(height, stripe_center + stripe_width // 2 + 1)
            phase[y_start:y_end, :] = stripe_rad

        # 交叉区域独立相位
        if intersect_rad is not None:
            half_width = stripe_width // 2
            x_centers = [int(round(center_x + i * stripe_spacing)) for i in index_list]
            y_centers = [int(round(center_y + i * stripe_spacing)) for i in index_list]
            for x_center in x_centers:
                for y_center in y_centers:
                    x_start = max(0, x_center - half_width)
                    x_end = min(width, x_center + half_width + 1)
                    y_start = max(0, y_center - half_width)
                    y_end = min(height, y_center + half_width + 1)
                    phase[y_start:y_end, x_start:x_end] = intersect_rad

        # 线性相位映射：0~2π -> 0~255
        phase_wrapped = np.mod(phase, 2 * np.pi)
        gray = phase_wrapped / (2 * np.pi) * 255.0
        return np.rint(gray).astype(np.uint8)

    # ------------------- 9. 内圈高斯 + 外圈反高斯复合光斑 -------------------
    @staticmethod
    def double_ring_phase(
        width=512,
        height=512,
        inner_radius=16.0,
        outer_radius=50.0,
        inner_intensity=0.7,
        outer_intensity=1.0,
        between_intensity=0.2,
        inner_width=None,
        outer_width=10.0,
        iterations=100,
        seed=2026,
    ):
        """Generate a phase-only hologram using the SLM_TEST radial model.

        The target is composed of a flat in-aperture baseline, a centered
        Gaussian peak, and a Gaussian edge peak at ``outer_radius``.  The
        ``inner_radius`` gate keeps the center component inside the requested
        inner spot while ``inner_width``/``outer_width`` control the two peak
        widths (equivalent to ``w_in``/``w_out`` in SLM_TEST.m).
        """
        width = int(width)
        height = int(height)
        if width < 32 or height < 32:
            raise ValueError("图像分辨率不能小于 32 像素")
        inner_radius = float(inner_radius)
        outer_radius = float(outer_radius)
        if not np.isfinite(inner_radius) or not np.isfinite(outer_radius):
            raise ValueError("内外圈半径必须是有限数值")
        if not (1 <= inner_radius < outer_radius):
            raise ValueError("必须满足 1 <= 内圈半径 < 外圈半径")
        if outer_radius > min(width, height) / 2:
            raise ValueError(
                f"外圈半径不能超过画布半径 {min(width, height) / 2:g} 像素"
            )
        for name, value in (("内圈中心光强", inner_intensity), ("外圈光强", outer_intensity), ("圈间光强", between_intensity)):
            if not 0 <= float(value) <= 1:
                raise ValueError(f"{name}必须在 0 到 1 之间")
        inner_width = inner_radius / 2.0 if inner_width is None else float(inner_width)
        outer_width = float(outer_width)
        if not np.isfinite(inner_width) or not np.isfinite(outer_width):
            raise ValueError("w_in 和 w_out 必须是有限数值")
        if inner_width <= 0 or outer_width <= 0:
            raise ValueError("w_in 和 w_out 必须大于 0")
        if inner_width > outer_radius or outer_width > outer_radius:
            raise ValueError("w_in 和 w_out 不能大于外圈半径")
        iterations = int(iterations)
        if not 1 <= iterations <= 200:
            raise ValueError("迭代次数必须在 1 到 200 之间")

        y, x = np.ogrid[:height, :width]
        cx = (width - 1) / 2.0
        cy = (height - 1) / 2.0
        radius = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
        # Match SLM_TEST.m: I_flat + center Gaussian + edge Gaussian,
        # restricted to the circular aperture R <= R_max.
        aperture = radius <= outer_radius
        inner_gate_edge = max(inner_width * 0.15, 0.75)
        inner_gate = 1.0 / (1.0 + np.exp((radius - inner_radius) / inner_gate_edge))
        inner_shape = np.exp(-0.5 * (radius / inner_width) ** 2) * inner_gate
        outer_shape = np.exp(-0.5 * ((radius - outer_radius) / outer_width) ** 2)
        target_intensity = (
            float(between_intensity)
            + (float(inner_intensity) - float(between_intensity)) * inner_shape
            + (float(outer_intensity) - float(between_intensity)) * outer_shape
        )
        target_intensity = np.where(aperture, target_intensity, 0.0)
        target_intensity = np.clip(target_intensity, 0.0, None)
        max_target = float(np.max(target_intensity))
        if max_target <= 0:
            raise ValueError("目标光强不能全部为零")
        target_intensity /= max_target

        rng = np.random.default_rng(int(seed))
        phase = rng.uniform(0.0, 2.0 * np.pi, (height, width))
        target_amplitude = np.sqrt(target_intensity)
        for _ in range(iterations):
            slm_field = np.exp(1j * phase)
            far_field = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(slm_field)))
            constrained_far = target_amplitude * np.exp(1j * np.angle(far_field))
            slm_back = np.fft.fftshift(np.fft.ifft2(np.fft.ifftshift(constrained_far)))
            phase = np.angle(slm_back)

        phase_uint8 = np.mod(phase, 2.0 * np.pi) / (2.0 * np.pi) * 255.0
        reconstructed = np.abs(np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(np.exp(1j * phase))))) ** 2
        reconstructed /= max(float(np.max(reconstructed)), 1e-12)
        return (
            np.rint(phase_uint8).astype(np.uint8),
            np.rint(target_intensity * 255.0).astype(np.uint8),
            np.rint(reconstructed * 255.0).astype(np.uint8),
        )

    @staticmethod
    def generate_phase(
        focus_mm,
        wavelength_nm,
        x_pixels=1272,
        y_pixels=1024,
        pitch_mode=1,
        rotation_degree=0.0,
        offset_x=0,
        offset_y=0,
        scale_factor=1.0,
        input_image=None
    ):
        """
        兼容旧版的菲涅尔透镜相位图生成
        """
        pitch = 20e-6 if pitch_mode == 0 else 12.5e-6  # X15223 actual: 12.5 um
        focus_m = focus_mm * 1e-3
        wavelength_m = wavelength_nm * 1e-9

        X, Y = SLMPatternGenerator._create_coordinate_grid(
            x_pixels, y_pixels, offset_x, offset_y, scale_factor, rotation_degree
        )

        r_pixels = np.sqrt(X**2 + Y**2)
        r_m = r_pixels * pitch

        k = 2 * np.pi / wavelength_m
        phase = -k * r_m**2 / (2 * focus_m)
        phase = phase % (2 * np.pi)
        phase_8bit = (phase / (2 * np.pi) * 255).astype(np.uint8)

        if input_image is not None:
            input_resized = np.array(
                Image.fromarray(input_image, mode='L').resize((x_pixels, y_pixels), Image.LANCZOS)
            )
            phase_8bit = (phase_8bit.astype(np.float32) + input_resized.astype(np.float32)) % 256
            phase_8bit = phase_8bit.astype(np.uint8)

        return phase_8bit


# ==================== CGH Simulation核心 ====================
class CGHSimulator:
    """计算机生成全息图（CGH）模拟器"""

    @staticmethod
    def generate_light_shape(shape, size_mm, width, height):
        """
        生成入射光斑形状

        参数:
            shape: 光斑形状（gaussian/flat-circle/flat-square）
            size_mm: 光斑尺寸（mm）
            width: 图像宽度
            height: 图像高度

        返回:
            numpy.ndarray: 光强分布
        """
        # 创建坐标网格，中心在原点
        x = np.linspace(-width/2, width/2, width)
        y = np.linspace(-height/2, height/2, height)
        X, Y = np.meshgrid(x, y)
        R = np.sqrt(X**2 + Y**2)

        # 将物理尺寸转换为像素单位（假设像素间距1.25μm）
        pixel_size_mm = 1.25e-3  # mm
        sigma_pixels = size_mm / (2 * pixel_size_mm)  # 1/e2直径对应sigma

        if shape == 'gaussian':
            # 高斯光斑：I = exp(-2*R^2 / sigma^2)
            light = np.exp(-2 * (R**2) / (sigma_pixels**2))

        elif shape == 'flat-circle':
            # 平顶圆形光斑
            radius_pixels = size_mm / (2 * pixel_size_mm)
            light = np.where(R <= radius_pixels, 1.0, 0.0)

        elif shape == 'flat-square':
            # 平顶方形光斑
            half_size = size_mm / (2 * pixel_size_mm)
            light = np.where((np.abs(X) <= half_size) & (np.abs(Y) <= half_size), 1.0, 0.0)

        else:
            light = np.ones((height, width))

        # 归一化
        light = light / np.sum(light)
        return light

    @staticmethod
    def gerchberg_saxton(target, light_shape, iterations=100):
        """
        Gerchberg-Saxton算法计算CGH相位

        参数:
            target: 目标图像（0-1范围）
            light_shape: 入射光强分布
            iterations: 迭代次数

        返回:
            tuple: (cgh_phase, regenerated)
        """
        # 初始化随机相位
        amplitude = np.sqrt(light_shape)
        phase = np.random.rand(*target.shape) * 2 * np.pi

        for i in range(iterations):
            # SLM平面 -> 远场
            complex_field = amplitude * np.exp(1j * phase)
            far_field = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(complex_field)))

            # 在远场替换振幅为目标振幅
            far_field_amplitude = np.abs(far_field)
            far_field_phase = np.angle(far_field)
            far_field_new = np.sqrt(target) * np.exp(1j * far_field_phase)

            # 远场 -> SLM平面
            slm_field = np.fft.fftshift(np.fft.ifft2(np.fft.ifftshift(far_field_new)))
            phase = np.angle(slm_field)

        # 最终CGH相位
        cgh_phase = ((phase + np.pi) / (2 * np.pi) * 255).astype(np.uint8)

        # 计算再生图像
        complex_field_final = amplitude * np.exp(1j * phase)
        far_field_final = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(complex_field_final)))
        regenerated = np.abs(far_field_final)**2
        regenerated = regenerated / np.max(regenerated)

        return cgh_phase, regenerated

    @staticmethod
    def over_compensation(target, light_shape, iterations=100):
        """
        OverCompensation算法（OC）
        对GS算法的改进，过补偿误差以加速收敛

        参数:
            target: 目标图像
            light_shape: 入射光强分布
            iterations: 迭代次数

        返回:
            tuple: (cgh_phase, regenerated)
        """
        amplitude = np.sqrt(light_shape)
        phase = np.random.rand(*target.shape) * 2 * np.pi

        # 过补偿因子
        alpha = 1.5

        for i in range(iterations):
            # SLM平面 -> 远场
            complex_field = amplitude * np.exp(1j * phase)
            far_field = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(complex_field)))

            # 计算远场振幅
            far_field_amplitude = np.abs(far_field)

            # 过补偿振幅修正
            compensated = target + alpha * (target - (far_field_amplitude**2))
            compensated = np.clip(compensated, 0, 1)

            far_field_phase = np.angle(far_field)
            far_field_new = np.sqrt(compensated) * np.exp(1j * far_field_phase)

            # 远场 -> SLM平面
            slm_field = np.fft.fftshift(np.fft.ifft2(np.fft.ifftshift(far_field_new)))
            phase = np.angle(slm_field)

        cgh_phase = ((phase + np.pi) / (2 * np.pi) * 255).astype(np.uint8)

        # 计算再生图像
        complex_field_final = amplitude * np.exp(1j * phase)
        far_field_final = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(complex_field_final)))
        regenerated = np.abs(far_field_final)**2
        regenerated = regenerated / np.max(regenerated)

        return cgh_phase, regenerated

    @staticmethod
    def calculate_cgh(target_image, algorithm='gs', light_shape='gaussian',
                     light_size=10, iterations=100, width=256, height=256,
                     gaussian_spots=False, spot_radius=10):
        """
        计算CGH

        参数:
            target_image: 目标图像PIL对象
            algorithm: 算法（gs/oc）
            light_shape: 光斑形状
            light_size: 光斑尺寸（mm）
            iterations: 迭代次数
            width: CGH宽度
            height: CGH高度
            gaussian_spots: 是否将光斑转换为高斯分布
            spot_radius: 高斯光斑半径（像素）

        返回:
            dict: 包含cgh、regenerated、light_shape的字典
        """
        # 调整目标图像尺寸
        target_img = target_image.convert('L').resize((width, height), Image.LANCZOS)
        target_array = np.array(target_img).astype(np.float32) / 255.0

        # 如果启用高斯光斑转换
        if gaussian_spots:
            target_array = CGHSimulator.convert_spots_to_gaussian(
                target_array, spot_radius=spot_radius, threshold=0.3
            )

        # 生成光斑形状
        light = CGHSimulator.generate_light_shape(light_shape, light_size, width, height)

        # 选择算法
        if algorithm == 'oc':
            cgh_phase, regenerated = CGHSimulator.over_compensation(
                target_array, light, iterations
            )
        else:
            cgh_phase, regenerated = CGHSimulator.gerchberg_saxton(
                target_array, light, iterations
            )

        return {
            'cgh_phase': cgh_phase,
            'regenerated': (regenerated * 255).astype(np.uint8),
            'light_shape': (light / np.max(light) * 255).astype(np.uint8),
            'processed_target': (target_array * 255).astype(np.uint8) if gaussian_spots else None
        }

    @staticmethod
    def convert_spots_to_gaussian(target_array, spot_radius=10, threshold=0.5):
        """
        将目标图像中的点状光斑转换为高斯光斑

        参数:
            target_array: 目标图像数组（0-1范围）
            spot_radius: 高斯光斑半径（像素）
            threshold: 光斑检测阈值（0-1）

        返回:
            numpy.ndarray: 处理后的目标图像
        """
        height, width = target_array.shape

        # 创建输出图像
        output = np.zeros_like(target_array)

        # 使用阈值检测光斑区域
        binary = (target_array > threshold).astype(np.uint8)

        # 标记连通域
        labeled, num_features = ndimage.label(binary)

        if num_features == 0:
            # 如果没有检测到光斑，返回原图
            return target_array

        # 对每个光斑生成高斯分布
        for i in range(1, num_features + 1):
            # 获取当前光斑的掩码
            spot_mask = labeled == i

            # 计算光斑中心（质心）
            y_coords, x_coords = np.where(spot_mask)
            if len(x_coords) == 0:
                continue

            center_x = np.mean(x_coords)
            center_y = np.mean(y_coords)

            # 计算光斑强度（基于原始光斑的总强度）
            spot_intensity = np.sum(target_array[spot_mask])

            # 在中心位置生成高斯分布
            y, x = np.ogrid[:height, :width]
            gaussian = np.exp(-((x - center_x)**2 + (y - center_y)**2) / (2 * spot_radius**2))

            # 归一化高斯分布，使其总强度与原光斑相近
            gaussian = gaussian / np.sum(gaussian) * spot_intensity

            # 叠加到输出图像
            output = output + gaussian

        # 归一化到0-1范围
        output = np.clip(output, 0, 1)

        return output


# ==================== BMP 格式转换器 ====================
def convert_to_bmp(image_data, width=None, height=None, grayscale=True):
    """
    将任意格式图像转换为 8-bit BMP

    参数:
        image_data: base64 编码的图像字符串（含 data URI 前缀）
        width: 输出宽度（可选）
        height: 输出高度（可选）
        grayscale: 是否转换为灰度，默认 True

    返回:
        dict: 包含转换后图像数组、PIL对象、信息字典
    """
    # 解码 base64
    if ',' in image_data:
        img_data = image_data.split(',')[1]
    else:
        img_data = image_data

    img_bytes = base64.b64decode(img_data)
    img = Image.open(io.BytesIO(img_bytes))

    # 记录原始信息
    original_info = {
        'original_mode': img.mode,
        'original_size': img.size,
        'original_format': img.format
    }

    # 转换为灰度（如果需要）
    if grayscale and img.mode != 'L':
        # 对于 RGBA，先合成到白色背景，再转灰度
        if img.mode == 'RGBA':
            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3])
            img = background
        img = img.convert('L')

    # 调整尺寸
    if width is not None and height is not None:
        width = int(width)
        height = int(height)
        if width < 1 or height < 1:
            raise ValueError("输出尺寸必须大于 0")
        img = img.resize((width, height), Image.LANCZOS)

    # 确保是 uint8
    img_array = np.array(img)
    if img_array.dtype != np.uint8:
        img_array = np.clip(img_array, 0, 255).astype(np.uint8)
        img = Image.fromarray(img_array, mode='L')

    # 如果已经是灰度但模式不是 L，强制转换
    if img.mode != 'L':
        img = img.convert('L')

    original_info['output_mode'] = img.mode
    original_info['output_size'] = img.size
    original_info['output_bit_depth'] = 8

    return {
        'image': img,
        'array': np.array(img),
        'info': original_info
    }


# ==================== 傅里叶面强度模拟 ====================
class FourierSimulator:
    """
    根据相位图模拟傅里叶面（远场）强度分布
    参考: test.py 中的 simulate_fourier_intensity 和 gaussian_illumination
    """

    @staticmethod
    def gaussian_illumination(width, height, beam_radius):
        """
        生成二维高斯光束照明
        参数:
            beam_radius: 高斯半径（像素）
        """
        x = np.arange(width) - width / 2
        y = np.arange(height) - height / 2
        xx, yy = np.meshgrid(x, y)
        amplitude = np.exp(-(xx ** 2 + yy ** 2) / beam_radius ** 2)
        return amplitude

    @staticmethod
    def simulate_fourier_intensity(phase, illumination=None):
        """
        根据相位图模拟傅里叶面强度分布

        参数:
            phase: 相位矩阵（弧度）
            illumination: 照明光束振幅（可选）
        返回:
            intensity_log: 归一化的对数强度分布 (0-1)
            intensity_raw: 归一化的原始强度分布 (0-1)
        """
        height, width = phase.shape

        if illumination is None:
            illumination = np.ones((height, width), dtype=np.float64)

        # SLM 出射复振幅
        complex_field = illumination * np.exp(1j * phase)

        # 傅里叶变换
        spectrum = np.fft.fftshift(np.fft.fft2(complex_field))
        intensity = np.abs(spectrum) ** 2

        # 对数显示，便于观察弱衍射结构
        intensity_log = np.log1p(intensity)
        if intensity_log.max() > 0:
            intensity_log = intensity_log / intensity_log.max()

        # 原始强度归一化
        intensity_raw = intensity / intensity.max() if intensity.max() > 0 else intensity

        return intensity_log, intensity_raw

    @staticmethod
    def gray_to_phase(gray_array):
        """将 8-bit 灰度图转换为相位（弧度），线性映射 0-255 -> 0-2π"""
        return gray_array.astype(np.float64) / 255.0 * 2 * np.pi

    @staticmethod
    def apply_colormap(gray_uint8, colormap='magma'):
        """
        将 8-bit 灰度图应用伪彩色映射，返回 RGB uint8 数组

        支持的 colormap: magma, jet, viridis, hot, inferno, grayscale
        """
        t = gray_uint8.astype(np.float64) / 255.0  # 归一化到 [0, 1]

        if colormap == 'grayscale':
            rgb = np.stack([gray_uint8, gray_uint8, gray_uint8], axis=-1)
            return rgb

        if colormap == 'hot':
            r = np.clip(t * 3, 0, 1)
            g = np.clip(t * 3 - 1, 0, 1)
            b = np.clip(t * 3 - 2, 0, 1)

        elif colormap == 'jet':
            r = np.clip(1.5 - np.abs(4 * t - 3), 0, 1)
            g = np.clip(1.5 - np.abs(4 * t - 2), 0, 1)
            b = np.clip(1.5 - np.abs(4 * t - 1), 0, 1)

        else:
            # magma / viridis / inferno / plasma 使用控制点插值
            control_points = {
                'magma': {
                    'r': [0.0, 0.03, 0.30, 0.65, 0.85, 1.00],
                    'g': [0.0, 0.02, 0.10, 0.35, 0.70, 1.00],
                    'b': [0.0, 0.15, 0.40, 0.30, 0.30, 1.00],
                },
                'viridis': {
                    'r': [0.27, 0.13, 0.25, 0.53, 0.80, 0.93],
                    'g': [0.00, 0.37, 0.65, 0.80, 0.88, 0.93],
                    'b': [0.33, 0.67, 0.42, 0.25, 0.18, 0.13],
                },
                'inferno': {
                    'r': [0.0, 0.25, 0.55, 0.80, 0.95, 1.00],
                    'g': [0.0, 0.04, 0.15, 0.40, 0.75, 1.00],
                    'b': [0.0, 0.30, 0.45, 0.20, 0.20, 1.00],
                },
                'plasma': {
                    'r': [0.05, 0.30, 0.60, 0.85, 0.95, 1.00],
                    'g': [0.03, 0.02, 0.15, 0.40, 0.70, 0.95],
                    'b': [0.50, 0.55, 0.50, 0.30, 0.15, 0.10],
                },
            }
            cp = control_points.get(colormap, control_points['magma'])
            cp_t = np.linspace(0, 1, len(cp['r']))
            r = np.interp(t, cp_t, cp['r'])
            g = np.interp(t, cp_t, cp['g'])
            b = np.interp(t, cp_t, cp['b'])

        rgb = np.stack([r, g, b], axis=-1)
        return (np.clip(rgb, 0, 1) * 255).astype(np.uint8)

    @staticmethod
    def run_simulation(phase_image_base64, illumination_type='uniform',
                       beam_radius=250, output_width=512, output_height=512,
                       colormap='magma'):
        """
        执行傅里叶面强度模拟

        参数:
            phase_image_base64: 相位图 base64 编码
            illumination_type: 'uniform' 或 'gaussian'
            beam_radius: 高斯光束半径（像素）
            output_width, output_height: 输出尺寸
            colormap: 伪彩色映射名称
        返回:
            dict: 包含模拟结果图像
        """
        # 解码输入图像
        if ',' in phase_image_base64:
            phase_image_base64 = phase_image_base64.split(',', 1)[1]
        image_data = base64.b64decode(phase_image_base64)
        phase_img = Image.open(io.BytesIO(image_data)).convert('L')

        # 调整尺寸
        if phase_img.size != (output_width, output_height):
            phase_img = phase_img.resize((output_width, output_height), Image.LANCZOS)

        gray_array = np.array(phase_img)
        phase = FourierSimulator.gray_to_phase(gray_array)

        # 生成照明光束
        if illumination_type == 'gaussian':
            illumination = FourierSimulator.gaussian_illumination(
                output_width, output_height, beam_radius
            )
        else:
            illumination = None

        # 模拟傅里叶面强度
        intensity_log, intensity_raw = FourierSimulator.simulate_fourier_intensity(
            phase, illumination
        )

        # 转换为 8-bit 图像
        intensity_log_img = (intensity_log * 255).astype(np.uint8)
        intensity_raw_img = (intensity_raw * 255).astype(np.uint8)

        # 伪彩色强度图
        intensity_color_img = FourierSimulator.apply_colormap(intensity_log_img, colormap)

        # RGB base64 辅助函数
        def array_rgb_to_base64(rgb_array):
            img = Image.fromarray(rgb_array, mode='RGB')
            buffer = io.BytesIO()
            img.save(buffer, format='PNG')
            buffer.seek(0)
            return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}"

        return {
            'intensity_log': SLMPatternGenerator.array_to_base64(intensity_log_img),
            'intensity_raw': SLMPatternGenerator.array_to_base64(intensity_raw_img),
            'intensity_color': array_rgb_to_base64(intensity_color_img),
            'colormap': colormap,
            'illumination_preview': SLMPatternGenerator.array_to_base64(
                (illumination * 255).astype(np.uint8) if illumination is not None
                else np.full((output_height, output_width), 255, dtype=np.uint8)
            ),
            'illumination_type': illumination_type,
            'beam_radius': beam_radius
        }


# ==================== 路由 ====================
@app.route('/')
def index():
    """主页 - 专业版CGH Simulation控制面板"""
    return render_template('index_pro.html')


@app.route('/api/generate', methods=['POST'])
def generate_phase():
    """生成相位图API"""
    try:
        # 获取参数
        data = request.json

        focus_mm = float(data.get('focus_mm', 1000))
        wavelength_nm = float(data.get('wavelength_nm', 532))
        x_pixels = int(data.get('x_pixels', 1272))
        y_pixels = int(data.get('y_pixels', 1024))
        pitch_mode = int(data.get('pitch_mode', 1))
        rotation_degree = float(data.get('rotation_degree', 0))
        offset_x = int(data.get('offset_x', 0))
        offset_y = int(data.get('offset_y', 0))
        scale_factor = float(data.get('scale_factor', 1.0))

        # 处理输入图像
        input_image = None
        if 'input_image' in data and data['input_image']:
            # 解码base64图像
            img_data = data['input_image'].split(',')[1]
            img_bytes = base64.b64decode(img_data)
            img = Image.open(io.BytesIO(img_bytes))
            input_image = np.array(img.convert('L'))

        # 生成相位图
        phase_array = SLMPatternGenerator.generate_phase(
            focus_mm=focus_mm,
            wavelength_nm=wavelength_nm,
            x_pixels=x_pixels,
            y_pixels=y_pixels,
            pitch_mode=pitch_mode,
            rotation_degree=rotation_degree,
            offset_x=offset_x,
            offset_y=offset_y,
            scale_factor=scale_factor,
            input_image=input_image
        )

        # 转换为base64
        img_base64 = SLMPatternGenerator.array_to_base64(phase_array)

        # 保存到文件
        output_dir = OUTPUT_DIR
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"fresnel_f{focus_mm}mm_w{wavelength_nm}nm_{timestamp}.bmp"
        filepath = os.path.join(output_dir, filename)
        SLMPatternGenerator.save_image(phase_array, filepath)

        # 记录历史
        history = GenerationHistory(
            config_name=f"Custom_f{focus_mm}mm_w{wavelength_nm}nm",
            focus_mm=focus_mm,
            wavelength_nm=wavelength_nm,
            output_file=filepath
        )
        db.session.add(history)
        db.session.commit()

        return jsonify({
            'success': True,
            'image': img_base64,
            'filename': filename,
            'filepath': filepath,
            'message': '相位图生成成功'
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


@app.route('/api/generate/<pattern_type>', methods=['POST'])
def generate_pattern(pattern_type):
    """
    生成SLM常见相位图
    支持: fresnel, fresnel_three_spots, three_spots, double_ring, axicon,
    cylindrical, blaze, sine, vortex, random, divide, cross
    """
    try:
        data = request.json or {}
        width = int(data.get('width', 1272))
        height = int(data.get('height', 1024))

        # 限制最大分辨率
        width = min(max(width, 64), 4096)
        height = min(max(height, 64), 4096)

        # 根据类型生成相位图
        target_array = None
        if pattern_type == 'fresnel':
            phase_array = SLMPatternGenerator.fresnel_lens(
                width=width,
                height=height,
                focal_length=float(data.get('focal_length', 1000)),
                wavelength=float(data.get('wavelength', 532)),
                pixel_size=float(data.get('pixel_size', 12.5e-3))
            )
            name = f"fresnel_f{data.get('focal_length', 1000)}mm_w{data.get('wavelength', 532)}nm"

        elif pattern_type == 'fresnel_three_spots':
            focal_length = float(data.get('focal_length', 1000))
            wavelength = float(data.get('wavelength', 532))
            spot_spacing = float(data.get('spot_spacing', 1.0))
            spot_count = int(data.get('spot_count', 3))
            pixel_size_um = float(data.get('pixel_size_um', 12.5))
            algorithm = str(data.get('algorithm', 'analytic'))
            incident_beam_diameter_mm = float(
                data.get('incident_beam_diameter_mm', 10.0)
            )
            iterations = int(data.get('iterations', 30))
            spot_radius_mm = data.get('spot_radius_mm')
            spot_radius_mm = (
                float(spot_radius_mm) if spot_radius_mm not in (None, '')
                else None
            )
            phase_direction = str(data.get('phase_direction', 'standard'))
            phase_array = SLMPatternGenerator.fresnel_three_spots(
                width=width,
                height=height,
                focal_length=focal_length,
                wavelength=wavelength,
                spot_spacing=spot_spacing,
                spot_count=spot_count,
                pixel_size_um=pixel_size_um,
                algorithm=algorithm,
                incident_beam_diameter_mm=incident_beam_diameter_mm,
                iterations=iterations,
                spot_radius_mm=spot_radius_mm,
                phase_direction=phase_direction
            )
            name = (
                f"fresnel_spots_f{focal_length:g}mm_"
                f"w{wavelength:g}nm_n{spot_count}_d{spot_spacing:g}mm_"
                f"{algorithm}_{phase_direction}"
            )

        elif pattern_type == 'three_spots':
            # 与菲涅尔多点聚焦相同参数，但不含菲涅尔透镜相位（纯分束光栅）
            focal_length = float(data.get('focal_length', 1000))
            wavelength = float(data.get('wavelength', 532))
            spot_spacing = float(data.get('spot_spacing', 1.0))
            spot_count = int(data.get('spot_count', 3))
            pixel_size_um = float(data.get('pixel_size_um', 12.5))
            algorithm = str(data.get('algorithm', 'analytic'))
            incident_beam_diameter_mm = float(
                data.get('incident_beam_diameter_mm', 10.0)
            )
            iterations = int(data.get('iterations', 30))
            spot_radius_mm = data.get('spot_radius_mm')
            spot_radius_mm = (
                float(spot_radius_mm) if spot_radius_mm not in (None, '')
                else None
            )
            phase_direction = str(data.get('phase_direction', 'standard'))
            phase_array = SLMPatternGenerator.fresnel_three_spots(
                width=width,
                height=height,
                focal_length=focal_length,
                wavelength=wavelength,
                spot_spacing=spot_spacing,
                spot_count=spot_count,
                pixel_size_um=pixel_size_um,
                algorithm=algorithm,
                incident_beam_diameter_mm=incident_beam_diameter_mm,
                iterations=iterations,
                spot_radius_mm=spot_radius_mm,
                phase_direction=phase_direction,
                with_lens=False
            )
            name = (
                f"three_spots_f{focal_length:g}mm_"
                f"w{wavelength:g}nm_n{spot_count}_d{spot_spacing:g}mm_"
                f"{algorithm}_{phase_direction}"
            )

        elif pattern_type == 'double_ring':
            inner_radius = float(data.get('inner_radius', 16.0))
            outer_radius = float(data.get('outer_radius', 50.0))
            inner_intensity = float(data.get('inner_intensity', 0.7))
            outer_intensity = float(data.get('outer_intensity', 1.0))
            between_intensity = float(data.get('between_intensity', 0.2))
            inner_width = float(data.get('inner_width', data.get('w_in', inner_radius / 2.0)))
            outer_width = float(data.get('outer_width', data.get('w_out', 10.0)))
            iterations = int(data.get('iterations', 100))
            seed = int(data.get('seed') or 2026)
            phase_array, target_array, reconstructed_array = SLMPatternGenerator.double_ring_phase(
                width=width,
                height=height,
                inner_radius=inner_radius,
                outer_radius=outer_radius,
                inner_intensity=inner_intensity,
                outer_intensity=outer_intensity,
                between_intensity=between_intensity,
                inner_width=inner_width,
                outer_width=outer_width,
                iterations=iterations,
                seed=seed,
            )
            target_preview = SLMPatternGenerator.array_to_base64(target_array)
            regenerated_preview = SLMPatternGenerator.array_to_base64(reconstructed_array)
            name = (
                f"double_ring_ri{inner_radius:g}_ro{outer_radius:g}_"
                f"wi{inner_width:g}_wo{outer_width:g}_"
                f"ii{inner_intensity:g}_oi{outer_intensity:g}_bi{between_intensity:g}"
            )

        elif pattern_type == 'axicon':
            phase_array = SLMPatternGenerator.axicon_lens(
                width=width,
                height=height,
                radius=float(data.get('radius', 100))
            )
            name = f"axicon_r{data.get('radius', 100)}"

        elif pattern_type == 'cylindrical':
            phase_array = SLMPatternGenerator.cylindrical_lens(
                width=width,
                height=height,
                focal_length=float(data.get('focal_length', 1000)),
                wavelength=float(data.get('wavelength', 532)),
                pixel_size=float(data.get('pixel_size', 25e-3)),
                angle=float(data.get('angle', 0))
            )
            name = (
                f"cylindrical_f{data.get('focal_length', 1000)}mm_"
                f"w{data.get('wavelength', 532)}nm_a{data.get('angle', 0)}"
            )

        elif pattern_type == 'blaze':
            phase_array = SLMPatternGenerator.blaze_grating(
                width=width,
                height=height,
                period=int(data.get('period', 50)),
                angle=float(data.get('angle', 0))
            )
            name = f"blaze_p{data.get('period', 50)}_a{data.get('angle', 0)}"

        elif pattern_type == 'sine':
            phase_array = SLMPatternGenerator.sine_grating(
                width=width,
                height=height,
                period=int(data.get('period', 50)),
                angle=float(data.get('angle', 0))
            )
            name = f"sine_p{data.get('period', 50)}_a{data.get('angle', 0)}"

        elif pattern_type == 'vortex':
            phase_array = SLMPatternGenerator.vortex_beam(
                width=width,
                height=height,
                lnumber=int(data.get('lnumber', 1))
            )
            name = f"vortex_l{data.get('lnumber', 1)}"

        elif pattern_type == 'random':
            phase_array = SLMPatternGenerator.random_image(
                width=width,
                height=height,
                seed=data.get('seed')
            )
            name = f"random_{width}x{height}"

        elif pattern_type == 'divide':
            phase_array = SLMPatternGenerator.divide_screen(
                width=width,
                height=height,
                grayvalue1=int(data.get('grayvalue1', 0)),
                grayvalue2=int(data.get('grayvalue2', 255))
            )
            name = f"divide_g{data.get('grayvalue1', 0)}_{data.get('grayvalue2', 255)}"

        elif pattern_type == 'cross':
            # 十字测试图：归一化相位参数（0-1 对应 0-2π）
            intersection = data.get('intersection_phase')
            phase_array = SLMPatternGenerator.cross_pattern(
                width=width,
                height=height,
                background_phase=float(data.get('background_phase', 0.5)),
                stripe_phase=float(data.get('stripe_phase', 0.0)),
                stripe_width=int(data.get('stripe_width', 12)),
                stripe_spacing=int(data.get('stripe_spacing', 28)),
                stripe_number=int(data.get('stripe_number', 3)),
                intersection_phase=float(intersection) if intersection is not None and intersection != '' else None
            )
            name = f"cross_w{data.get('stripe_width', 12)}_s{data.get('stripe_spacing', 28)}_n{data.get('stripe_number', 3)}"

        else:
            return jsonify({
                'success': False,
                'error': f'不支持的图案类型: {pattern_type}'
            }), 400

        # 转换为base64
        img_base64 = SLMPatternGenerator.array_to_base64(phase_array)

        # 保存到文件
        output_dir = OUTPUT_DIR
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"{name}_{timestamp}.bmp"
        filepath = os.path.join(output_dir, filename)
        preview_only = pattern_type == 'double_ring' and bool(data.get('preview', False))
        if not preview_only:
            SLMPatternGenerator.save_image(phase_array, filepath)
        else:
            filename = None
            filepath = None

        # Automatic previews should not flood the persistent history table.
        if not preview_only:
            history = GenerationHistory(
                config_name=name,
                focus_mm=float(data.get('focal_length', 0)),
                wavelength_nm=float(data.get('wavelength', 0)),
                output_file=filepath
            )
            db.session.add(history)
            db.session.commit()

        response = {
            'success': True,
            'image': img_base64,
            'filename': filename,
            'filepath': filepath,
            'pattern_type': pattern_type,
            'message': f'{pattern_type} 相位图生成成功'
        }
        if pattern_type == 'double_ring':
            response.update({
                'target_image': target_preview,
                'reconstructed_image': regenerated_preview,
            })
        return jsonify(response)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


@app.route('/api/cgh/calculate', methods=['POST'])
def calculate_cgh_api():
    """
    计算CGH
    请求体:
    {
        "target_image": "data:image/png;base64,...",
        "algorithm": "gs" | "oc",
        "light_shape": "gaussian" | "flat-circle" | "flat-square",
        "light_size": 10,
        "iterations": 100,
        "width": 256,
        "height": 256,
        "gaussian_spots": false,
        "spot_radius": 10
    }
    """
    try:
        data = request.json

        # 解码目标图像
        target_image_data = data.get('target_image')
        if not target_image_data:
            return jsonify({
                'success': False,
                'error': '请提供目标图像'
            }), 400

        img_data = target_image_data.split(',')[1]
        img_bytes = base64.b64decode(img_data)
        target_image = Image.open(io.BytesIO(img_bytes))

        # 获取参数
        algorithm = data.get('algorithm', 'gs')
        light_shape = data.get('light_shape', 'gaussian')
        light_size = float(data.get('light_size', 10))
        iterations = int(data.get('iterations', 100))
        width = int(data.get('width', 256))
        height = int(data.get('height', 256))
        gaussian_spots = bool(data.get('gaussian_spots', False))
        spot_radius = float(data.get('spot_radius', 10))

        # 限制迭代次数
        iterations = min(max(iterations, 1), 1000)

        # 计算CGH
        result = CGHSimulator.calculate_cgh(
            target_image=target_image,
            algorithm=algorithm,
            light_shape=light_shape,
            light_size=light_size,
            iterations=iterations,
            width=width,
            height=height,
            gaussian_spots=gaussian_spots,
            spot_radius=spot_radius
        )

        cgh_phase = result['cgh_phase']
        regenerated = result['regenerated']
        light_shape_img = result['light_shape']

        # 转换为base64
        cgh_base64 = SLMPatternGenerator.array_to_base64(cgh_phase)
        regenerated_base64 = SLMPatternGenerator.array_to_base64(regenerated)
        light_base64 = SLMPatternGenerator.array_to_base64(light_shape_img)

        # 如果有处理后的目标图像，也返回
        processed_target_base64 = None
        if result.get('processed_target') is not None:
            processed_target_base64 = SLMPatternGenerator.array_to_base64(result['processed_target'])

        # 保存CGH到文件
        output_dir = OUTPUT_DIR
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        gaussian_suffix = "_gaussian" if gaussian_spots else ""
        filename = f"cgh_{algorithm}_{light_shape}_{width}x{height}{gaussian_suffix}_{timestamp}.bmp"
        filepath = os.path.join(output_dir, filename)
        SLMPatternGenerator.save_image(cgh_phase, filepath)

        # 记录历史
        history = GenerationHistory(
            config_name=f"CGH_{algorithm}_{light_shape}{'_gaussian' if gaussian_spots else ''}",
            focus_mm=0,
            wavelength_nm=0,
            input_image='uploaded',
            output_file=filepath
        )
        db.session.add(history)
        db.session.commit()

        return jsonify({
            'success': True,
            'cgh_image': cgh_base64,
            'regenerated_image': regenerated_base64,
            'light_shape_image': light_base64,
            'processed_target_image': processed_target_base64,
            'filename': filename,
            'filepath': filepath,
            'message': 'CGH计算成功',
            'info': {
                'algorithm': algorithm,
                'light_shape': light_shape,
                'light_size': light_size,
                'iterations': iterations,
                'width': width,
                'height': height,
                'gaussian_spots': gaussian_spots,
                'spot_radius': spot_radius
            }
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


@app.route('/api/convert-to-bmp', methods=['POST'])
def convert_image_to_bmp():
    """
    将任意格式图像转换为 8-bit BMP
    用于兼容 SLM 官方软件输入要求
    """
    try:
        data = request.json or {}

        # 获取输入图像
        image_data = data.get('image')
        if not image_data:
            return jsonify({
                'success': False,
                'error': '请提供输入图像'
            }), 400

        # 获取可选参数
        width = data.get('width')
        height = data.get('height')
        grayscale = data.get('grayscale', True)

        # 转换为整数或 None
        if width is not None:
            width = int(width)
        if height is not None:
            height = int(height)

        # 执行转换
        result = convert_to_bmp(image_data, width=width, height=height, grayscale=grayscale)
        img = result['image']
        info = result['info']

        # 保存为 BMP
        output_dir = OUTPUT_DIR
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"converted_{timestamp}.bmp"
        filepath = os.path.join(output_dir, filename)
        img.save(filepath, format='BMP')

        # 生成 base64 预览
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')  # 预览用 PNG
        buffer.seek(0)
        preview_base64 = f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}"

        # 记录历史
        history = GenerationHistory(
            config_name='BMP_Converter',
            focus_mm=0,
            wavelength_nm=0,
            input_image='uploaded',
            output_file=filepath
        )
        db.session.add(history)
        db.session.commit()

        return jsonify({
            'success': True,
            'image': preview_base64,
            'filename': filename,
            'filepath': filepath,
            'message': '图像已成功转换为 8-bit BMP',
            'info': info
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


@app.route('/api/presets', methods=['GET'])
def get_presets():
    """获取所有预设配置"""
    presets = PresetConfig.query.order_by(PresetConfig.created_at.desc()).all()
    return jsonify({
        'success': True,
        'presets': [p.to_dict() for p in presets]
    })


@app.route('/api/presets', methods=['POST'])
def save_preset():
    """保存预设配置"""
    try:
        data = request.json
        preset = PresetConfig(
            name=data.get('name'),
            description=data.get('description', ''),
            focus_mm=float(data.get('focus_mm')),
            wavelength_nm=float(data.get('wavelength_nm')),
            x_pixels=int(data.get('x_pixels', 1272)),
            y_pixels=int(data.get('y_pixels', 1024)),
            pitch_mode=int(data.get('pitch_mode', 1)),
            rotation_degree=float(data.get('rotation_degree', 0)),
            offset_x=int(data.get('offset_x', 0)),
            offset_y=int(data.get('offset_y', 0)),
            scale_factor=float(data.get('scale_factor', 1.0))
        )
        db.session.add(preset)
        db.session.commit()

        return jsonify({
            'success': True,
            'preset': preset.to_dict(),
            'message': '预设保存成功'
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


@app.route('/api/presets/<int:preset_id>', methods=['DELETE'])
def delete_preset(preset_id):
    """删除预设配置"""
    try:
        preset = PresetConfig.query.get_or_404(preset_id)
        db.session.delete(preset)
        db.session.commit()

        return jsonify({
            'success': True,
            'message': '预设删除成功'
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


# ==================== 傅里叶面强度模拟 API ====================
@app.route('/api/simulate/fourier', methods=['POST'])
def simulate_fourier():
    """
    傅里叶面强度模拟API
    参数:
        phase_image: 相位图 base64 编码（必填）
        illumination_type: 照明类型 'uniform' 或 'gaussian'（默认 uniform）
        beam_radius: 高斯光束半径（像素，默认 250）
        width: 输出宽度（默认 512）
        height: 输出高度（默认 512）
    """
    try:
        data = request.get_json()
        phase_image = data.get('phase_image', '')

        if not phase_image:
            return jsonify({
                'success': False,
                'error': '请提供相位图'
            }), 400

        illumination_type = data.get('illumination_type', 'uniform')
        beam_radius = float(data.get('beam_radius', 250))
        width = int(data.get('width', 512))
        height = int(data.get('height', 512))
        colormap = data.get('colormap', 'magma')

        result = FourierSimulator.run_simulation(
            phase_image_base64=phase_image,
            illumination_type=illumination_type,
            beam_radius=beam_radius,
            output_width=width,
            output_height=height,
            colormap=colormap
        )

        return jsonify({
            'success': True,
            'intensity_log_image': result['intensity_log'],
            'intensity_raw_image': result['intensity_raw'],
            'intensity_color_image': result['intensity_color'],
            'colormap': result['colormap'],
            'illumination_preview': result['illumination_preview'],
            'illumination_type': result['illumination_type'],
            'beam_radius': result['beam_radius'],
            'message': '傅里叶面强度模拟完成'
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


@app.route('/api/history', methods=['GET'])
def get_history():
    """获取生成历史"""
    history = GenerationHistory.query.order_by(GenerationHistory.created_at.desc()).limit(50).all()
    return jsonify({
        'success': True,
        'history': [h.to_dict() for h in history]
    })


@app.route('/api/download/<path:filename>')
def download_file(filename):
    """下载文件"""
    try:
        filepath = os.path.join(OUTPUT_DIR, filename)
        return send_file(filepath, as_attachment=True)
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 404


# ==================== 初始化默认预设 ====================
def init_default_presets():
    """初始化默认预设配置"""
    default_presets = [
        {
            'name': '绿光标准聚焦',
            'description': '532nm绿光，1000mm焦距，标准参数',
            'focus_mm': 1000,
            'wavelength_nm': 532
        },
        {
            'name': '红光长焦距',
            'description': '633nm红光，2000mm长焦距',
            'focus_mm': 2000,
            'wavelength_nm': 633
        },
        {
            'name': '蓝光短焦距',
            'description': '473nm蓝光，500mm短焦距',
            'focus_mm': 500,
            'wavelength_nm': 473
        },
        {
            'name': '高分辨率模式',
            'description': '使用更小的像素间距（20μm）',
            'focus_mm': 1000,
            'wavelength_nm': 532,
            'pitch_mode': 0
        }
    ]

    for preset_data in default_presets:
        # 检查是否已存在
        existing = PresetConfig.query.filter_by(name=preset_data['name']).first()
        if not existing:
            preset = PresetConfig(**preset_data)
            db.session.add(preset)

    db.session.commit()


# ==================== 主程序 ====================
if __name__ == '__main__':
    # 创建数据库表
    with app.app_context():
        db.create_all()
        init_default_presets()

    # 运行应用
    print("\n" + "="*60)
    print("菲涅尔透镜相位图生成系统 - Web界面")
    print("="*60)
    print("访问地址: http://127.0.0.1:5000")
    print("按 Ctrl+C 停止服务器")
    print("="*60 + "\n")

    app.run(debug=True, host='0.0.0.0', port=5000)
