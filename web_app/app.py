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
import math
import os
import shutil
import threading
import zipfile
import uuid
import re
from datetime import datetime
import json
from functools import lru_cache
from scipy import ndimage
from sqlalchemy import inspect
from slam_motion import (
    calibrate_pixel_to_sample_um,
    plan_motion_frames,
    sample_to_focus_um,
    validate_minimum_spacing,
)

# 创建Flask应用
app = Flask(__name__)
app.config['SECRET_KEY'] = 'fresnel_lens_secret_key_2026'
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get(
    'SLMJOMO_DATABASE_URI', 'sqlite:///fresnel_config.db'
)
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# 输出目录（绝对路径，确保保存和下载路径一致）
OUTPUT_DIR = os.environ.get(
    'SLMJOMO_OUTPUT_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output_phase_patterns')
)
os.makedirs(OUTPUT_DIR, exist_ok=True)
LINGO_OUTPUT_DIR = os.environ.get(
    'SLMJOMO_LINGO_OUTPUT_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output', 'Lingo')
)

# 初始化数据库
db = SQLAlchemy(app)

# 注册 USB_SLMControl 模块（Hamamatsu LCOS-SLM USB 控制还原）
from usb_slm_routes import usb_slm_bp  # noqa: E402
app.register_blueprint(usb_slm_bp)


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
    parameters_json = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        try:
            parameters = json.loads(self.parameters_json) if self.parameters_json else None
        except (TypeError, ValueError):
            parameters = None
        return {
            'id': self.id,
            'config_name': self.config_name,
            'focus_mm': self.focus_mm,
            'wavelength_nm': self.wavelength_nm,
            'input_image': self.input_image,
            'output_file': self.output_file,
            'parameters': parameters,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S')
        }


HISTORY_PARAMETER_FIELDS = {
    'focus_mm', 'wavelength_nm', 'focal_length', 'wavelength',
    'x_pixels', 'y_pixels', 'width', 'height', 'pitch_mode',
    'rotation_degree', 'offset_x', 'offset_y', 'scale_factor',
    'pixel_size', 'pixel_size_um', 'spot_spacing', 'spot_count',
    'algorithm', 'legacy_algorithm', 'incident_beam_diameter_mm', 'spot_radius_mm',
    'iterations', 'phase_direction', 'target_spots', 'radius', 'angle',
    'period', 'lnumber', 'seed', 'grayvalue1', 'grayvalue2',
    'background_phase', 'stripe_phase', 'stripe_width', 'stripe_spacing',
    'stripe_number', 'intersection_phase', 'inner_radius', 'outer_radius',
    'inner_width', 'outer_width', 'inner_intensity', 'outer_intensity',
    'between_intensity', 'light_shape', 'light_size', 'gaussian_spots',
    'spot_radius', 'grayscale'
}


def normalize_history_parameters(pattern_type, data):
    """Keep a small allowlisted parameter snapshot without image payloads."""
    if not isinstance(data, dict) or not isinstance(pattern_type, str) or len(pattern_type) > 80:
        return None

    parameters = {}
    for key in HISTORY_PARAMETER_FIELDS:
        if key not in data:
            continue
        value = data[key]
        if key == 'target_spots':
            if not isinstance(value, list) or len(value) > 15:
                continue
            spots = []
            for spot in value:
                if not isinstance(spot, dict):
                    spots = []
                    break
                point = {axis: spot.get(axis) for axis in ('x_mm', 'y_mm', 'weight')}
                if any(not isinstance(number, (int, float)) or isinstance(number, bool) or
                       not math.isfinite(number) or abs(number) > 1_000_000
                       for number in point.values()):
                    spots = []
                    break
                spots.append(point)
            if spots:
                parameters[key] = spots
        elif value is None or isinstance(value, bool):
            parameters[key] = value
        elif isinstance(value, (int, float)):
            if math.isfinite(value) and abs(value) <= 1_000_000_000:
                parameters[key] = value
        elif isinstance(value, str) and len(value) <= 100:
            parameters[key] = value

    snapshot = {'version': 1, 'pattern_type': pattern_type, 'parameters': parameters}
    encoded = json.dumps(snapshot, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    return snapshot if len(encoded) <= 8192 else None


def migrate_generation_history_schema(engine=None):
    """Add the nullable history snapshot column without rewriting legacy rows."""
    engine = engine or db.engine
    if engine.dialect.name != 'sqlite':
        return
    with engine.begin() as connection:
        inspector = inspect(connection)
        if 'generation_history' not in inspector.get_table_names():
            return
        columns = {column['name'] for column in inspector.get_columns('generation_history')}
        if 'parameters_json' not in columns:
            connection.exec_driver_sql(
                'ALTER TABLE generation_history ADD COLUMN parameters_json TEXT'
            )


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
        target_spots=None,
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
        if target_spots is not None:
            target_spots = SLMPatternGenerator._normalize_target_spots(target_spots)
            spot_count = len(target_spots)
        if not 1 <= spot_count <= 15:
            raise ValueError("光斑数量必须在 1 到 15 之间")
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
        if algorithm == 'gaussian_wgs' and target_spots is not None:
            pixel_count = width * height
            if pixel_count * spot_count > 20_000_000:
                raise ValueError("自由阵列点数与分辨率组合过大，请降低分辨率或点数")
            work_estimate = pixel_count * iterations * (2 + 0.5 * spot_count)
            if work_estimate > 400_000_000:
                raise ValueError("自由阵列计算量过大，请降低分辨率、迭代次数或点数")

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
                spot_radius_mm=spot_radius_mm,
                target_spots=target_spots
            )
        elif algorithm == 'uniform_grating':
            if target_spots is not None:
                phase = SLMPatternGenerator._uniform_2d_spot_grating_phase(
                    X=X,
                    Y=Y,
                    focal_length=focal_length,
                    wavelength_mm=wavelength_mm,
                    target_spots=target_spots,
                    with_lens=with_lens
                )
            else:
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
            center_x_mm = 0.0
            center_y_mm = 0.0
            if target_spots is not None:
                ordered = sorted(target_spots, key=lambda spot: spot['x_mm'])
                dx1 = ordered[1]['x_mm'] - ordered[0]['x_mm']
                dx2 = ordered[2]['x_mm'] - ordered[1]['x_mm']
                scale = max(abs(dx1), abs(dx2), 1.0)
                tolerance = scale * 1e-6
                if dx1 <= 0 or abs(dx1 - dx2) > tolerance or any(
                    abs(spot['y_mm'] - ordered[0]['y_mm']) > tolerance
                    for spot in ordered[1:]
                ):
                    raise ValueError(
                        "1×3 达曼光栅要求三个光斑位于同一水平线上且等间距"
                    )
                spot_spacing = (dx1 + dx2) / 2
                center_x_mm = sum(spot['x_mm'] for spot in ordered) / 3
                center_y_mm = sum(spot['y_mm'] for spot in ordered) / 3
            phase = SLMPatternGenerator._dammann_three_spot_phase(
                X=X,
                Y=Y,
                focal_length=focal_length,
                wavelength_mm=wavelength_mm,
                pixel_size_mm=pixel_size_mm,
                spot_spacing=spot_spacing,
                incident_beam_diameter_mm=incident_beam_diameter_mm,
                with_lens=with_lens,
                center_x_mm=center_x_mm,
                center_y_mm=center_y_mm
            )
        else:
            field = np.zeros((height, width), dtype=np.complex128)
            if target_spots is None:
                target_positions = [
                    (position, 0.0, 1.085 if spot_count == 3 and index == 1 else 1.0)
                    for index, position in enumerate(
                        (np.arange(spot_count) - (spot_count - 1) / 2) * spot_spacing
                    )
                ]
            else:
                target_positions = [
                    (spot['x_mm'], spot['y_mm'], spot['weight'])
                    for spot in target_spots
                ]
            if with_lens:
                for target_x, target_y, weight in target_positions:
                    optical_path = np.sqrt(
                        (X - target_x) ** 2 + (Y - target_y) ** 2 + focal_length ** 2
                    )
                    field += weight * np.exp(
                        -1j * k * (optical_path - focal_length)
                    )
            else:
                # 无透镜：抛物线近似的远场分束（纯线性相位光栅）
                for target_x, target_y, weight in target_positions:
                    field += weight * np.exp(
                        1j * k * (X * target_x + Y * target_y) / focal_length
                    )
            phase = np.angle(field)

        if phase_direction == 'inverted':
            phase = -phase

        phase = np.mod(phase, 2 * np.pi)
        return np.rint(phase / (2 * np.pi) * 255).astype(np.uint8)

    @staticmethod
    def _normalize_target_spots(target_spots):
        if not isinstance(target_spots, (list, tuple)):
            raise ValueError("光斑坐标必须是二维数组")
        if not 1 <= len(target_spots) <= 15:
            raise ValueError("光斑数量必须在 1 到 15 之间")

        normalized = []
        for index, spot in enumerate(target_spots):
            if not isinstance(spot, dict):
                raise ValueError(f"第 {index + 1} 个光斑坐标格式无效")
            try:
                x_mm = float(spot['x_mm'])
                y_mm = float(spot['y_mm'])
                weight = float(spot.get('weight', 1.0))
            except (KeyError, TypeError, ValueError):
                raise ValueError(f"第 {index + 1} 个光斑坐标格式无效")
            if not np.isfinite(x_mm) or not np.isfinite(y_mm):
                raise ValueError("光斑坐标必须是有限数值")
            if not np.isfinite(weight) or not 0.01 <= weight <= 10:
                raise ValueError("光斑权重必须在 0.01 到 10 之间")
            normalized.append({
                'x_mm': x_mm,
                'y_mm': y_mm,
                'weight': weight
            })

        for index, spot in enumerate(normalized):
            for other in normalized[index + 1:]:
                if np.hypot(
                    spot['x_mm'] - other['x_mm'],
                    spot['y_mm'] - other['y_mm']
                ) <= 1e-12:
                    raise ValueError("光斑位置不能重叠")
        return normalized

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
    def _uniform_2d_spot_grating_phase(
        X,
        Y,
        focal_length,
        wavelength_mm,
        target_spots,
        with_lens=True
    ):
        """Encode arbitrary 2D focal-plane orders with equal field weights."""
        k = 2 * np.pi / wavelength_mm
        grating_field = np.zeros(X.shape, dtype=np.complex128)
        for spot in target_spots:
            grating_field += np.sqrt(spot['weight']) * np.exp(
                1j * k * (
                    X * spot['x_mm'] + Y * spot['y_mm']
                ) / focal_length
            )
        grating_phase = np.angle(grating_field)
        if not with_lens:
            return grating_phase
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
        with_lens=True,
        center_x_mm=0.0,
        center_y_mm=0.0
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
        if center_x_mm or center_y_mm:
            grating_phase = grating_phase + (2 * np.pi / wavelength_mm) * (
                X * center_x_mm + Y * center_y_mm
            ) / focal_length
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
        spot_radius_mm=None,
        target_spots=None
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
        output_half_height = min(abs(output_y[0]), abs(output_y[-1]))
        if target_spots is None:
            positions = np.column_stack((
                (np.arange(spot_count) - (spot_count - 1) / 2) * spot_spacing,
                np.zeros(spot_count)
            ))
            requested_power = np.ones(spot_count, dtype=np.float64)
        else:
            target_spots = SLMPatternGenerator._normalize_target_spots(
                target_spots
            )
            positions = np.array([
                [spot['x_mm'], spot['y_mm']] for spot in target_spots
            ], dtype=np.float64)
            requested_power = np.array([
                spot['weight'] for spot in target_spots
            ], dtype=np.float64)
            spot_count = len(target_spots)

        if np.any(np.abs(positions[:, 0]) >= output_half_width) or \
                np.any(np.abs(positions[:, 1]) >= output_half_height):
            raise ValueError(
                "光斑坐标超出当前参数可生成范围 "
                f"(X < {output_half_width:g} mm, "
                f"Y < {output_half_height:g} mm)"
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
        pair_distances = np.linalg.norm(
            positions[:, np.newaxis, :] - positions[np.newaxis, :, :],
            axis=2
        )
        pair_distances[pair_distances == 0] = np.inf
        nearest_distances = np.min(pair_distances, axis=1)
        if np.any(nearest_distances < 2 * target_waist):
            raise ValueError(
                f"相邻光斑距离过小，当前参数至少需要 "
                f"{2 * target_waist:g} mm 才能形成可分辨高斯点"
            )
        if target_spots is not None and (
            np.any(np.abs(positions[:, 0]) + 2.5 * target_waist >= output_half_width) or
            np.any(np.abs(positions[:, 1]) + 2.5 * target_waist >= output_half_height)
        ):
            raise ValueError("光斑边缘超出当前参数可生成范围")
        spot_profiles = [
            np.exp(
                -((target_x - x0) ** 2 + (target_y - y0) ** 2) /
                target_waist**2
            ).astype(np.float32)
            for x0, y0 in positions
        ]
        power_regions = []
        region_radius = min(
            2.5 * target_waist,
            0.45 * float(np.min(nearest_distances))
        )
        for x0, y0 in positions:
            center_x = int(np.argmin(np.abs(output_x - x0)))
            center_y = int(np.argmin(np.abs(output_y - y0)))
            radius_x = max(1, int(np.ceil(region_radius / output_dx)))
            radius_y = max(1, int(np.ceil(region_radius / output_dy)))
            y_slice = slice(
                max(0, center_y - radius_y),
                min(height, center_y + radius_y + 1)
            )
            x_slice = slice(
                max(0, center_x - radius_x),
                min(width, center_x + radius_x + 1)
            )
            local_x, local_y = np.meshgrid(
                output_x[x_slice], output_y[y_slice]
            )
            mask = (
                (local_x - x0) ** 2 + (local_y - y0) ** 2
            ) <= region_radius**2
            power_regions.append((y_slice, x_slice, mask))

        desired_power = requested_power / np.mean(requested_power)
        weights = np.ones(spot_count, dtype=np.float64)
        target_amplitude = sum(
            np.sqrt(power) * profile
            for power, profile in zip(desired_power, spot_profiles)
        )
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
                np.sum(intensity[y_slice, x_slice][mask])
                for y_slice, x_slice, mask in power_regions
            ])
            measured_ratio = measured_power / np.maximum(
                np.mean(measured_power), 1e-30
            )
            correction = np.sqrt(
                desired_power / np.maximum(measured_ratio, 1e-30)
            )
            weights *= correction**0.7
            weights /= np.mean(weights)

            target_amplitude = sum(
                adaptive_weight * np.sqrt(power) * profile
                for adaptive_weight, power, profile in zip(
                    weights, desired_power, spot_profiles
                )
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
    def decode_phase_image(phase_image_base64, output_width, output_height):
        """解码 base64 相位图为灰度数组，并调整到指定输出尺寸"""
        if ',' in phase_image_base64:
            phase_image_base64 = phase_image_base64.split(',', 1)[1]
        image_data = base64.b64decode(phase_image_base64)
        phase_img = Image.open(io.BytesIO(image_data)).convert('L')

        if phase_img.size != (output_width, output_height):
            phase_img = phase_img.resize((output_width, output_height), Image.LANCZOS)
        return np.array(phase_img)

    @staticmethod
    def build_illumination(illumination_type, width, height, beam_radius):
        """根据照明类型生成照明振幅矩阵，uniform 返回 None"""
        if illumination_type == 'gaussian':
            return FourierSimulator.gaussian_illumination(width, height, beam_radius)
        return None

    @staticmethod
    def _rgb_to_base64(rgb_array):
        """将 RGB uint8 数组编码为 PNG base64 data URL"""
        img = Image.fromarray(rgb_array, mode='RGB')
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)
        return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}"

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
        gray_array = FourierSimulator.decode_phase_image(
            phase_image_base64, output_width, output_height
        )
        phase = FourierSimulator.gray_to_phase(gray_array)

        # 生成照明光束
        illumination = FourierSimulator.build_illumination(
            illumination_type, output_width, output_height, beam_radius
        )

        # 模拟傅里叶面强度
        intensity_log, intensity_raw = FourierSimulator.simulate_fourier_intensity(
            phase, illumination
        )

        # 转换为 8-bit 图像
        intensity_log_img = (intensity_log * 255).astype(np.uint8)
        intensity_raw_img = (intensity_raw * 255).astype(np.uint8)

        # 伪彩色强度图
        intensity_color_img = FourierSimulator.apply_colormap(intensity_log_img, colormap)

        return {
            'intensity_log': SLMPatternGenerator.array_to_base64(intensity_log_img),
            'intensity_raw': SLMPatternGenerator.array_to_base64(intensity_raw_img),
            'intensity_color': FourierSimulator._rgb_to_base64(intensity_color_img),
            'colormap': colormap,
            'illumination_preview': SLMPatternGenerator.array_to_base64(
                (illumination * 255).astype(np.uint8) if illumination is not None
                else np.full((output_height, output_width), 255, dtype=np.uint8)
            ),
            'illumination_type': illumination_type,
            'beam_radius': beam_radius
        }

    # ---- 序列（视频）模拟 ----
    MAX_SEQUENCE_FRAMES = 60

    @staticmethod
    def run_sequence_simulation(phase_images, illumination_type='uniform',
                                beam_radius=250, output_width=512, output_height=512,
                                colormap='magma'):
        """
        批量模拟多帧相位图的傅里叶面强度，用于序列（视频）播放

        参数:
            phase_images: 相位图 base64 列表
            其余参数与 run_simulation 相同
        返回:
            dict: frames 列表，每帧包含彩色/对数/原始强度图与统计信息
        """
        illumination = FourierSimulator.build_illumination(
            illumination_type, output_width, output_height, beam_radius
        )

        frames = []
        for index, phase_image_base64 in enumerate(phase_images):
            gray_array = FourierSimulator.decode_phase_image(
                phase_image_base64, output_width, output_height
            )
            phase = FourierSimulator.gray_to_phase(gray_array)
            intensity_log, intensity_raw = FourierSimulator.simulate_fourier_intensity(
                phase, illumination
            )

            intensity_log_img = (intensity_log * 255).astype(np.uint8)
            intensity_color_img = FourierSimulator.apply_colormap(
                intensity_log_img, colormap
            )

            frames.append({
                'index': index,
                'intensity_log': SLMPatternGenerator.array_to_base64(intensity_log_img),
                'intensity_raw': SLMPatternGenerator.array_to_base64(
                    (intensity_raw * 255).astype(np.uint8)
                ),
                'intensity_color': FourierSimulator._rgb_to_base64(intensity_color_img),
                'mean_intensity': round(float(np.mean(intensity_raw)), 6),
                'peak_intensity': round(float(np.max(intensity_raw)), 6),
            })

        return {
            'frames': frames,
            'frame_count': len(frames),
            'colormap': colormap,
            'illumination_type': illumination_type,
            'beam_radius': beam_radius,
            'output_width': output_width,
            'output_height': output_height
        }

    @staticmethod
    def export_sequence_gif(phase_images, illumination_type='uniform',
                            beam_radius=250, output_width=512, output_height=512,
                            colormap='magma', frame_duration_ms=200,
                            intensity_mode='color'):
        """
        将相位图序列的傅里叶面强度模拟结果导出为动画 GIF 字节流

        参数:
            frame_duration_ms: 每帧显示时长（毫秒）
            intensity_mode: 'color' 彩色强度 或 'log' 对数灰度
        """
        if intensity_mode not in ('color', 'log'):
            raise ValueError("intensity_mode 必须为 'color' 或 'log'")

        result = FourierSimulator.run_sequence_simulation(
            phase_images=phase_images,
            illumination_type=illumination_type,
            beam_radius=beam_radius,
            output_width=output_width,
            output_height=output_height,
            colormap=colormap
        )

        key = 'intensity_color' if intensity_mode == 'color' else 'intensity_log'
        pil_frames = []
        for frame in result['frames']:
            image_data = base64.b64decode(frame[key].split(',', 1)[1])
            img = Image.open(io.BytesIO(image_data))
            if img.mode != 'RGB':
                img = img.convert('RGB')
            pil_frames.append(img)

        buffer = io.BytesIO()
        pil_frames[0].save(
            buffer,
            format='GIF',
            save_all=True,
            append_images=pil_frames[1:],
            duration=max(20, int(frame_duration_ms)),
            loop=0,
            optimize=True
        )
        buffer.seek(0)
        return buffer.getvalue()


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
        if not (64 <= x_pixels <= 4096 and 64 <= y_pixels <= 4096):
            raise ValueError('图像宽高必须在 64 到 4096 像素之间')
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
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        filename = f"fresnel_f{focus_mm}mm_w{wavelength_nm}nm_{timestamp}.bmp"
        filepath = os.path.join(output_dir, filename)
        SLMPatternGenerator.save_image(phase_array, filepath)

        # 记录历史
        history = GenerationHistory(
            config_name=f"Custom_f{focus_mm}mm_w{wavelength_nm}nm",
            focus_mm=focus_mm,
            wavelength_nm=wavelength_nm,
            output_file=filepath,
            parameters_json=json.dumps(
                normalize_history_parameters('fresnel', data),
                ensure_ascii=False, allow_nan=False
            )
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
        if not (64 <= width <= 4096 and 64 <= height <= 4096):
            raise ValueError('图像宽高必须在 64 到 4096 像素之间')

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
            target_spots = data.get('target_spots')
            if target_spots is not None:
                target_spots = SLMPatternGenerator._normalize_target_spots(
                    target_spots
                )
                spot_count = len(target_spots)
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
                target_spots=target_spots
            )
            name = (
                f"fresnel_spots_f{focal_length:g}mm_"
                f"w{wavelength:g}nm_n{spot_count}_d{spot_spacing:g}mm_"
                f"{algorithm}_{phase_direction}"
                f"{'_custom' if target_spots is not None else ''}"
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
            target_spots = data.get('target_spots')
            if target_spots is not None:
                target_spots = SLMPatternGenerator._normalize_target_spots(
                    target_spots
                )
                spot_count = len(target_spots)
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
                with_lens=False,
                target_spots=target_spots
            )
            name = (
                f"three_spots_f{focal_length:g}mm_"
                f"w{wavelength:g}nm_n{spot_count}_d{spot_spacing:g}mm_"
                f"{algorithm}_{phase_direction}"
                f"{'_custom' if target_spots is not None else ''}"
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
                output_file=filepath,
                parameters_json=json.dumps(
                    normalize_history_parameters(pattern_type, data),
                    ensure_ascii=False, allow_nan=False
                )
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
        if pattern_type in ('fresnel_three_spots', 'three_spots') and target_spots is not None:
            response['target_spots'] = SLMPatternGenerator._normalize_target_spots(
                target_spots
            )
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
            output_file=filepath,
            parameters_json=json.dumps(
                normalize_history_parameters('cgh', data),
                ensure_ascii=False, allow_nan=False
            )
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


CGH_SEQUENCE_MAX_FRAMES = 200
CGH_SEQUENCE_MAX_FRAME_IMAGE_CHARS = 24 * 1024 * 1024


@app.route('/api/cgh/sequence/export', methods=['POST'])
def export_cgh_sequence_zip():
    """
    将多帧 CGH 相位图序列导出为 ZIP（8-bit BMP 序列），用于 SLM 软件按帧连续播放
    请求体:
    {
        "frames": ["data:image/png;base64,...", ...],  # 相位图 base64 列表（1~200 帧）
        "prefix": "可选 ZIP 内文件名前缀，默认 cgh"
    }
    """
    try:
        data = request.get_json() or {}
        frames = data.get('frames', [])
        prefix = data.get('prefix', 'cgh')

        if not isinstance(frames, list) or not frames:
            return jsonify({
                'success': False,
                'error': '请提供相位图帧列表 frames'
            }), 400
        if len(frames) > CGH_SEQUENCE_MAX_FRAMES:
            return jsonify({
                'success': False,
                'error': f'序列帧数过多，最多支持 {CGH_SEQUENCE_MAX_FRAMES} 帧'
            }), 400
        if not isinstance(prefix, str):
            return jsonify({'success': False, 'error': 'prefix 必须为字符串'}), 400
        prefix = ''.join(ch for ch in prefix if ch.isalnum() or ch in '-_').strip('-_') or 'cgh'
        prefix = prefix[:50]

        decoded_frames = []
        for index, frame in enumerate(frames):
            if not isinstance(frame, str) or not frame:
                return jsonify({
                    'success': False,
                    'error': f'第 {index + 1} 帧图像无效'
                }), 400
            if len(frame) > CGH_SEQUENCE_MAX_FRAME_IMAGE_CHARS:
                return jsonify({
                    'success': False,
                    'error': f'第 {index + 1} 帧图像过大'
                }), 400
            try:
                img_data = frame.split(',', 1)[1] if ',' in frame else frame
                img_bytes = base64.b64decode(img_data, validate=True)
                img = Image.open(io.BytesIO(img_bytes))
            except Exception:
                return jsonify({
                    'success': False,
                    'error': f'第 {index + 1} 帧不是有效的图像数据'
                }), 400
            if img.mode != 'L':
                img = img.convert('L')
            decoded_frames.append(img)

        pad = max(3, len(str(len(decoded_frames))))
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', compression=zipfile.ZIP_DEFLATED) as zip_file:
            for index, img in enumerate(decoded_frames, start=1):
                frame_buffer = io.BytesIO()
                img.save(frame_buffer, format='BMP')
                zip_file.writestr(
                    f'{prefix}_frame_{str(index).zfill(pad)}.bmp',
                    frame_buffer.getvalue()
                )

        zip_buffer.seek(0)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        return send_file(
            zip_buffer,
            mimetype='application/zip',
            as_attachment=True,
            download_name=f'{prefix}_sequence_{timestamp}.zip'
        )

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
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
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
            output_file=filepath,
            parameters_json=json.dumps(
                normalize_history_parameters('converter', data),
                ensure_ascii=False, allow_nan=False
            )
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


@app.route('/api/simulate/fourier/sequence', methods=['POST'])
def simulate_fourier_sequence():
    """
    傅里叶面强度序列模拟API：对多帧相位图批量模拟，用于视频播放
    参数:
        phase_images: 相位图 base64 列表（必填，1~60 帧）
        illumination_type / beam_radius / width / height / colormap 与单帧模拟相同
    """
    try:
        data = request.get_json() or {}
        phase_images = data.get('phase_images', [])

        if not isinstance(phase_images, list) or not phase_images:
            return jsonify({
                'success': False,
                'error': '请提供相位图列表 phase_images'
            }), 400
        if len(phase_images) > FourierSimulator.MAX_SEQUENCE_FRAMES:
            return jsonify({
                'success': False,
                'error': f'序列帧数过多，最多支持 {FourierSimulator.MAX_SEQUENCE_FRAMES} 帧'
            }), 400
        if any((not isinstance(item, str)) or not item for item in phase_images):
            return jsonify({
                'success': False,
                'error': '相位图列表中包含无效项'
            }), 400

        result = FourierSimulator.run_sequence_simulation(
            phase_images=phase_images,
            illumination_type=data.get('illumination_type', 'uniform'),
            beam_radius=float(data.get('beam_radius', 250)),
            output_width=int(data.get('width', 512)),
            output_height=int(data.get('height', 512)),
            colormap=data.get('colormap', 'magma')
        )

        return jsonify({
            'success': True,
            'frame_count': result['frame_count'],
            'frames': result['frames'],
            'colormap': result['colormap'],
            'illumination_type': result['illumination_type'],
            'beam_radius': result['beam_radius'],
            'message': f"傅里叶面序列模拟完成，共 {result['frame_count']} 帧"
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 400


@app.route('/api/simulate/fourier/export-gif', methods=['POST'])
def export_fourier_sequence_gif():
    """
    将傅里叶面序列模拟结果导出为动画 GIF
    额外参数:
        frame_duration_ms: 每帧时长（毫秒，默认 200，范围 20~2000）
        intensity_mode: 'color' 或 'log'（默认 color）
    """
    try:
        data = request.get_json() or {}
        phase_images = data.get('phase_images', [])

        if not isinstance(phase_images, list) or not phase_images:
            return jsonify({
                'success': False,
                'error': '请提供相位图列表 phase_images'
            }), 400
        if len(phase_images) > FourierSimulator.MAX_SEQUENCE_FRAMES:
            return jsonify({
                'success': False,
                'error': f'序列帧数过多，最多支持 {FourierSimulator.MAX_SEQUENCE_FRAMES} 帧'
            }), 400
        if any((not isinstance(item, str)) or not item for item in phase_images):
            return jsonify({
                'success': False,
                'error': '相位图列表中包含无效项'
            }), 400

        frame_duration_ms = min(2000, max(20, int(data.get('frame_duration_ms', 200))))

        gif_bytes = FourierSimulator.export_sequence_gif(
            phase_images=phase_images,
            illumination_type=data.get('illumination_type', 'uniform'),
            beam_radius=float(data.get('beam_radius', 250)),
            output_width=int(data.get('width', 512)),
            output_height=int(data.get('height', 512)),
            colormap=data.get('colormap', 'magma'),
            frame_duration_ms=frame_duration_ms,
            intensity_mode=data.get('intensity_mode', 'color')
        )

        return send_file(
            io.BytesIO(gif_bytes),
            mimetype='image/gif',
            as_attachment=True,
            download_name=f'fourier_sequence_{datetime.now().strftime("%Y%m%d_%H%M%S")}.gif'
        )

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
        output_root = os.path.realpath(OUTPUT_DIR)
        filepath = os.path.realpath(os.path.join(output_root, filename))
        if os.path.commonpath([output_root, filepath]) != output_root:
            return jsonify({'success': False, 'error': '文件不存在'}), 404
        if not os.path.isfile(filepath):
            return jsonify({'success': False, 'error': '文件不存在'}), 404
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


# ==================== SLAM 三光斑独立运动 ====================
SLAM_MOTION_MAX_FRAMES = 200
SLAM_MOTION_MAX_WAYPOINTS = 256
# Bound the amount of phase/reconstruction work accepted by one request.  The
# frame-count limit alone still permits several gigabytes at the largest
# supported resolution.
SLAM_MOTION_MAX_ESTIMATED_PIXELS = 450_000_000
SLAM_MOTION_MAX_COMPLETED_JOBS = 32
SLAM_MOTION_JOBS = {}
SLAM_MOTION_JOBS_LOCK = threading.RLock()
SLAM_MOTION_USB_LOCK = threading.Lock()


def _get_slam_motion_job(job_id):
    """Return an in-memory job or restore a completed job from its manifest."""
    job_id = str(job_id)
    with SLAM_MOTION_JOBS_LOCK:
        job = SLAM_MOTION_JOBS.get(job_id)
    if job is not None or not re.fullmatch(r'[0-9a-f]{32}', job_id):
        return job

    try:
        for date_name in os.listdir(LINGO_OUTPUT_DIR):
            if not re.fullmatch(r'\d{8}', date_name):
                continue
            directory = os.path.join(LINGO_OUTPUT_DIR, date_name, job_id)
            manifest_path = os.path.join(directory, 'manifest.json')
            if not os.path.isfile(manifest_path):
                continue
            with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
                manifest = json.load(manifest_file)
            frames = manifest.get('frames')
            if manifest.get('job_id') != job_id or not isinstance(frames, list) or not frames:
                continue
            valid_frames = all(
                isinstance(frame, dict)
                and isinstance(frame.get('phase_file'), str)
                and os.path.basename(frame['phase_file']) == frame['phase_file']
                and os.path.isfile(os.path.join(directory, frame['phase_file']))
                for frame in frames
            )
            if not valid_frames:
                continue
            restored = {
                'id': job_id,
                'status': 'complete',
                'plan': frames,
                'paths': manifest.get('paths', []),
                'calibration': manifest.get('calibration', {}),
                'parameters': manifest.get('parameters', {}),
                'generated_frames': frames,
                'next_index': len(frames),
                'directory': directory,
                'final_dir': directory,
                'output_path': os.path.join('output', 'Lingo', date_name, job_id),
                'lock': threading.Lock(),
                'error': None,
            }
            with SLAM_MOTION_JOBS_LOCK:
                return SLAM_MOTION_JOBS.setdefault(job_id, restored)
    except (OSError, ValueError, TypeError):
        return None
    return None


def _motion_number(value, name, minimum=None, maximum=None):
    if isinstance(value, bool):
        raise ValueError(f'{name} 必须是有限数值')
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{name} 必须是有限数值') from None
    if not math.isfinite(number):
        raise ValueError(f'{name} 必须是有限数值')
    if minimum is not None and number < minimum:
        raise ValueError(f'{name} 不能小于 {minimum:g}')
    if maximum is not None and number > maximum:
        raise ValueError(f'{name} 不能大于 {maximum:g}')
    return number


def _motion_integer(value, name, minimum=1, maximum=None):
    number = _motion_number(value, name, minimum, maximum)
    if not number.is_integer():
        raise ValueError(f'{name} 必须是整数')
    return int(number)


def _validate_motion_request(payload):
    if not isinstance(payload, dict):
        raise ValueError('请求必须是 JSON 对象')
    calibration = payload.get('calibration')
    if not isinstance(calibration, dict):
        raise ValueError('缺少 calibration 标定参数')
    calibration = {
        'origin_x_px': _motion_number(calibration.get('origin_x_px'), 'origin_x_px'),
        'origin_y_px': _motion_number(calibration.get('origin_y_px'), 'origin_y_px'),
        'pixels_per_um': _motion_number(
            calibration.get('pixels_per_um'), 'pixels_per_um', 1e-9
        ),
        'y_up': calibration.get('y_up', True),
        'focus_scale_x': _motion_number(
            calibration.get('focus_scale_x', 1), 'focus_scale_x', 1e-9
        ),
        'focus_scale_y': _motion_number(
            calibration.get('focus_scale_y', 1), 'focus_scale_y', 1e-9
        ),
        'rotation_deg': _motion_number(
            calibration.get('rotation_deg', 0), 'rotation_deg'
        ),
        'magnification': _motion_number(
            calibration.get('magnification', 50), 'magnification', 1e-9
        ),
    }
    if not isinstance(calibration['y_up'], bool):
        raise ValueError('y_up 必须是布尔值')
    calibrate_pixel_to_sample_um(
        calibration['origin_x_px'], calibration['origin_y_px'],
        calibration['origin_x_px'], calibration['origin_y_px'],
        calibration['pixels_per_um'], calibration['y_up']
    )
    sample_to_focus_um(
        0, 0, calibration['focus_scale_x'], calibration['focus_scale_y'],
        calibration['rotation_deg']
    )

    parameters = payload.get('parameters')
    if not isinstance(parameters, dict):
        raise ValueError('缺少 parameters 光学参数')
    parameters = {
        'focal_length_um': _motion_number(
            parameters.get('focal_length_um', 1000), 'focal_length_um', 1
        ),
        'wavelength_nm': _motion_number(
            parameters.get('wavelength_nm', 532), 'wavelength_nm', 1
        ),
        'magnification': _motion_number(
            parameters.get('magnification', calibration['magnification']),
            'magnification', 1e-9
        ),
        'algorithm': str(parameters.get('algorithm', 'gaussian_wgs')),
        'phase_direction': str(parameters.get('phase_direction', 'standard')),
        'incident_beam_diameter_mm': _motion_number(
            parameters.get('incident_beam_diameter_mm', 6),
            'incident_beam_diameter_mm', 1e-9
        ),
        'spot_diameter_um': _motion_number(
            parameters.get('spot_diameter_um', 6), 'spot_diameter_um', 5, 8
        ),
        'width': _motion_integer(parameters.get('width', 1272), 'width', 64, 4096),
        'height': _motion_integer(parameters.get('height', 1024), 'height', 64, 4096),
        'speed_um_s': _motion_number(
            parameters.get('speed_um_s', 2), 'speed_um_s', 1e-9
        ),
        'frame_interval_ms': _motion_integer(
            parameters.get('frame_interval_ms', 200),
            'frame_interval_ms', 1, 3600000
        ),
        'iterations': _motion_integer(
            parameters.get('iterations', 30), 'iterations', 1, 200
        ),
        'output_width': _motion_integer(
            parameters.get('output_width', 512), 'output_width', 64, 2048
        ),
        'output_height': _motion_integer(
            parameters.get('output_height', 512), 'output_height', 64, 2048
        ),
    }
    if parameters['algorithm'] not in (
        'uniform_grating', 'gaussian_wgs', 'dammann', 'analytic'
    ):
        raise ValueError('不支持的三光斑生成算法')
    if parameters['phase_direction'] not in ('standard', 'inverted'):
        raise ValueError('phase_direction 必须是 standard 或 inverted')

    paths = payload.get('paths')
    if not isinstance(paths, list) or len(paths) != 3:
        raise ValueError('paths 必须包含三个独立光斑路径')
    for index, path in enumerate(paths):
        if not isinstance(path, dict):
            raise ValueError(f'第 {index + 1} 条路径格式无效')
        waypoints = path.get('waypoints')
        if not isinstance(waypoints, list) or len(waypoints) > SLAM_MOTION_MAX_WAYPOINTS:
            raise ValueError(
                f'第 {index + 1} 条路径 waypoint 数量须在 1 到 '
                f'{SLAM_MOTION_MAX_WAYPOINTS} 之间'
            )

    frames = plan_motion_frames(
        paths,
        speed_um_s=parameters['speed_um_s'],
        frame_interval_ms=parameters['frame_interval_ms'],
        max_frames=SLAM_MOTION_MAX_FRAMES
    )
    minimum_spacing = parameters['spot_diameter_um']
    validate_minimum_spacing(frames, minimum_spacing)
    estimated_pixels = len(frames) * (
        parameters['width'] * parameters['height'] +
        parameters['output_width'] * parameters['output_height']
    )
    if estimated_pixels > SLAM_MOTION_MAX_ESTIMATED_PIXELS:
        raise ValueError(
            f'运动任务预计处理像素量 {estimated_pixels} 超过上限 '
            f'{SLAM_MOTION_MAX_ESTIMATED_PIXELS}'
        )

    focal_length_mm = parameters['focal_length_um'] / 1000
    wavelength_mm = parameters['wavelength_nm'] / 1e6
    pixel_size_mm = 12.5 / 1000
    half_width_um = (
        wavelength_mm * focal_length_mm / (2 * pixel_size_mm) * 1000
    )
    half_height_um = half_width_um * parameters['height'] / parameters['width']
    margin_um = (
        2.5 * parameters['spot_diameter_um'] / 2
        if parameters['algorithm'] == 'gaussian_wgs' else 0
    )
    for frame in frames:
        points = sorted(frame['spots'], key=lambda spot: spot['x_um'])
        for spot in frame['spots']:
            if abs(spot['x_um']) + margin_um >= half_width_um or \
                    abs(spot['y_um']) + margin_um >= half_height_um:
                raise ValueError(
                    '光斑坐标超出当前 SLM 分辨率与焦距的生成视场'
                )
        if parameters['algorithm'] == 'dammann':
            dx1 = points[1]['x_um'] - points[0]['x_um']
            dx2 = points[2]['x_um'] - points[1]['x_um']
            tolerance = max(abs(dx1), abs(dx2), 1) * 1e-6
            if dx1 <= 0 or abs(dx1 - dx2) > tolerance or any(
                abs(spot['y_um'] - points[0]['y_um']) > tolerance
                for spot in points[1:]
            ):
                raise ValueError(
                    '1×3 达曼光栅要求全路径保持水平、等间距的三点结构'
                )

    return calibration, parameters, paths, frames


def _motion_job_status(job):
    frame_urls = []
    for frame in job['generated_frames']:
        index = frame['index']
        frame_urls.append({
            **frame,
            'phase_url': f"/api/slam/motion/jobs/{job['id']}/frames/{index}/phase",
            'reconstruction_url': (
                f"/api/slam/motion/jobs/{job['id']}/frames/{index}/reconstruction"
            ),
        })
    return {
        'success': True,
        'job_id': job['id'],
        'status': job['status'],
        'frame_count': len(job['plan']),
        'generated_count': len(job['generated_frames']),
        'progress': round(100 * len(job['generated_frames']) / len(job['plan'])),
        'frames': frame_urls,
        'error': job.get('error'),
        'output_path': job.get('output_path'),
        'export_url': (
            f"/api/slam/motion/jobs/{job['id']}/export.zip"
            if job['status'] == 'complete' else None
        ),
    }


@app.route('/api/slam/motion/jobs', methods=['POST'])
def create_slam_motion_job():
    try:
        payload = request.get_json(silent=True) or {}
        calibration, parameters, paths, frames = _validate_motion_request(payload)
        with SLAM_MOTION_JOBS_LOCK:
            active = sum(
                job['status'] in ('planned', 'running')
                for job in SLAM_MOTION_JOBS.values()
            )
            if active >= 4:
                return jsonify({
                    'success': False,
                    'error': '当前已有 4 个运动任务，请完成或关闭后再试'
                }), 409
            completed = sum(
                job['status'] == 'complete'
                for job in SLAM_MOTION_JOBS.values()
            )
            if completed >= SLAM_MOTION_MAX_COMPLETED_JOBS:
                return jsonify({
                    'success': False,
                    'error': '已完成运动任务数量达到上限，请清理旧任务输出后再试'
                }), 409

            job_id = uuid.uuid4().hex
            date_folder = datetime.now().strftime('%Y%m%d')
            date_root = os.path.join(LINGO_OUTPUT_DIR, date_folder)
            os.makedirs(date_root, exist_ok=True)
            staging_dir = os.path.join(date_root, f'.{job_id}.tmp')
            final_dir = os.path.join(date_root, job_id)
            os.makedirs(staging_dir, exist_ok=False)
            job = {
                'id': job_id,
                'status': 'planned',
                'plan': frames,
                'paths': paths,
                'calibration': calibration,
                'parameters': parameters,
                'generated_frames': [],
                'next_index': 0,
                'staging_dir': staging_dir,
                'final_dir': final_dir,
                'directory': staging_dir,
                'output_path': os.path.join('output', 'Lingo', date_folder, job_id),
                'lock': threading.Lock(),
                'error': None,
            }
            SLAM_MOTION_JOBS[job_id] = job
        response = _motion_job_status(job)
        return jsonify(response), 202
    except (TypeError, ValueError, OSError) as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400


@app.route('/api/slam/motion/jobs/<job_id>', methods=['GET'])
def get_slam_motion_job(job_id):
    job = _get_slam_motion_job(job_id)
    if job is None:
        return jsonify({'success': False, 'error': '运动任务不存在'}), 404
    return jsonify(_motion_job_status(job))


@app.route('/api/slam/motion/jobs/<job_id>/next', methods=['POST'])
def generate_next_slam_motion_frame(job_id):
    with SLAM_MOTION_JOBS_LOCK:
        job = SLAM_MOTION_JOBS.get(job_id)
    if job is None:
        return jsonify({'success': False, 'error': '运动任务不存在'}), 404

    with job['lock']:
        if job['status'] == 'complete':
            return jsonify(_motion_job_status(job)), 409
        if job['status'] == 'failed':
            return jsonify(_motion_job_status(job)), 409
        frame_index = job['next_index']
        if frame_index >= len(job['plan']):
            return jsonify({'success': False, 'error': '运动任务状态无效'}), 409
        job['status'] = 'running'
        frame = job['plan'][frame_index]
        parameters = job['parameters']
        target_spots = [
            {
                'x_mm': spot['x_um'] / 1000,
                'y_mm': spot['y_um'] / 1000,
                'weight': 1.0,
            }
            for spot in frame['spots']
        ]
        try:
            phase_array = SLMPatternGenerator.fresnel_three_spots(
                width=parameters['width'],
                height=parameters['height'],
                focal_length=parameters['focal_length_um'] / 1000,
                wavelength=parameters['wavelength_nm'],
                spot_count=3,
                spot_spacing=1.0,
                pixel_size_um=12.5,
                algorithm=parameters['algorithm'],
                incident_beam_diameter_mm=parameters['incident_beam_diameter_mm'],
                iterations=parameters['iterations'],
                phase_direction=parameters['phase_direction'],
                spot_radius_mm=parameters['spot_diameter_um'] / 2000,
                target_spots=target_spots,
            )
            phase_path = os.path.join(
                job['staging_dir'], f"phase_{frame_index + 1:04d}.bmp"
            )
            Image.fromarray(phase_array, mode='L').save(phase_path, format='BMP')
            phase_data = SLMPatternGenerator.array_to_base64(phase_array)
            simulation = FourierSimulator.run_simulation(
                phase_data,
                illumination_type='uniform',
                output_width=parameters['output_width'],
                output_height=parameters['output_height'],
                colormap='magma'
            )
            reconstruction_data = simulation['intensity_color'].split(',', 1)[1]
            reconstruction_bytes = base64.b64decode(reconstruction_data, validate=True)
            reconstruction_path = os.path.join(
                job['staging_dir'], f"reconstruction_{frame_index + 1:04d}.png"
            )
            with open(reconstruction_path, 'wb') as output_file:
                output_file.write(reconstruction_bytes)

            generated = {
                'index': frame_index,
                'time_s': frame['time_s'],
                'duration_ms': frame['duration_ms'],
                'spots': frame['spots'],
                'phase_file': os.path.basename(phase_path),
                'reconstruction_file': os.path.basename(reconstruction_path),
            }
            job['generated_frames'].append(generated)
            job['next_index'] += 1
            if job['next_index'] == len(job['plan']):
                manifest = {
                    'job_id': job['id'],
                    'calibration': job['calibration'],
                    'parameters': parameters,
                    'paths': job['paths'],
                    'frames': job['generated_frames'],
                }
                manifest_path = os.path.join(job['staging_dir'], 'manifest.json')
                with open(manifest_path, 'w', encoding='utf-8') as manifest_file:
                    json.dump(manifest, manifest_file, ensure_ascii=False, allow_nan=False)
                os.replace(job['staging_dir'], job['final_dir'])
                job['directory'] = job['final_dir']
                job['status'] = 'complete'
            response = _motion_job_status(job)
            response.update({
                'index': frame_index,
                'completed_frames': job['next_index'],
                'complete': job['status'] == 'complete',
            })
            return jsonify(response)
        except Exception as exc:  # noqa: BLE001
            job['status'] = 'failed'
            job['error'] = str(exc)
            shutil.rmtree(job['staging_dir'], ignore_errors=True)
            return jsonify(_motion_job_status(job)), 422


def _motion_frame_path(job, index, kind):
    if job['status'] != 'complete' or not 0 <= index < len(job['generated_frames']):
        return None
    file_key = 'phase_file' if kind == 'phase' else 'reconstruction_file'
    return os.path.join(job['directory'], job['generated_frames'][index][file_key])


@app.route('/api/slam/motion/jobs/<job_id>/frames/<int:index>/phase', methods=['GET'])
def get_slam_motion_phase_frame(job_id, index):
    job = _get_slam_motion_job(job_id)
    path = _motion_frame_path(job, index, 'phase') if job else None
    if path is None or not os.path.isfile(path):
        return jsonify({'success': False, 'error': '相位帧不存在'}), 404
    return send_file(path, mimetype='image/bmp', conditional=True)


@app.route('/api/slam/motion/jobs/<job_id>/frames/<int:index>/reconstruction', methods=['GET'])
def get_slam_motion_reconstruction_frame(job_id, index):
    job = _get_slam_motion_job(job_id)
    path = _motion_frame_path(job, index, 'reconstruction') if job else None
    if path is None or not os.path.isfile(path):
        return jsonify({'success': False, 'error': '重建帧不存在'}), 404
    return send_file(path, mimetype='image/png', conditional=True)


@app.route('/api/slam/motion/jobs/<job_id>/export.zip', methods=['GET'])
def export_slam_motion_job(job_id):
    job = _get_slam_motion_job(job_id)
    if job is None:
        return jsonify({'success': False, 'error': '运动任务不存在'}), 404
    with job['lock']:
        if job['status'] != 'complete':
            return jsonify({'success': False, 'error': '运动任务尚未完整生成'}), 409
        zip_path = os.path.join(job['directory'], 'phase_sequence.zip')
        if not os.path.isfile(zip_path):
            temporary_zip = os.path.join(
                job['directory'], f'.phase_sequence.{uuid.uuid4().hex}.tmp'
            )
            try:
                with zipfile.ZipFile(
                    temporary_zip, 'w', compression=zipfile.ZIP_STORED
                ) as archive:
                    for frame in job['generated_frames']:
                        archive.write(
                            os.path.join(job['directory'], frame['phase_file']),
                            arcname=frame['phase_file']
                        )
                    archive.write(
                        os.path.join(job['directory'], 'manifest.json'),
                        arcname='manifest.json'
                    )
                os.replace(temporary_zip, zip_path)
            finally:
                if os.path.exists(temporary_zip):
                    os.remove(temporary_zip)
    return send_file(
        zip_path,
        mimetype='application/zip',
        as_attachment=True,
        download_name=f"slam_motion_{job_id}.zip",
        conditional=True
    )


@app.route('/api/usb_slm/motion/upload', methods=['POST'])
def upload_slam_motion_job_to_usb_slm():
    from usb_slm_control import (
        SLMDriverError,
        SLMSequenceUploadError,
        USB_SLMController,
        X_PIXEL,
        Y_PIXEL,
    )

    data = request.get_json(silent=True) or {}
    job = _get_slam_motion_job(data.get('job_id', ''))
    if job is None:
        return jsonify({'success': False, 'error': '运动任务不存在'}), 404
    if job['status'] != 'complete':
        return jsonify({'success': False, 'error': '运动任务尚未完整生成'}), 409
    if data.get('overwrite_confirmed') is not True:
        return jsonify({'success': False, 'error': '覆盖 FMem 槽位前必须确认'}), 400
    try:
        parameters = job['parameters']
        if (parameters['width'], parameters['height']) != (X_PIXEL, Y_PIXEL):
            raise ValueError('USB_SLMControl 只接受 1272×1024 相位帧')
        start_slot = _motion_integer(data.get('start_slot'), 'start_slot', 0, 818)
        frame_count = len(job['generated_frames'])
        if start_slot + frame_count > 819:
            raise ValueError('相位帧数量超出可用 FMem 槽位范围 0–818')
        prepared_frames = []
        steps = []
        for offset, frame in enumerate(job['generated_frames']):
            phase_path = os.path.join(job['directory'], frame['phase_file'])
            if not os.path.isfile(phase_path):
                raise ValueError(f"第 {offset + 1} 帧相位文件不存在")
            with Image.open(phase_path) as source:
                phase_image = source.convert('L')
            if phase_image.size != (X_PIXEL, Y_PIXEL):
                raise ValueError(f"第 {offset + 1} 帧尺寸不符合 1272×1024")
            prepared_frames.append(phase_image.tobytes())
            steps.append({
                'slot': start_slot + offset,
                'duration_ms': frame['duration_ms'],
            })

        controller = USB_SLMController.instance()
        with SLAM_MOTION_USB_LOCK:
            transaction = controller.write_fmem_sequence(
                prepared_frames,
                steps,
                loop=bool(data.get('loop', True)),
                require_real=True,
            )
        return jsonify({
            'success': True,
            'uploaded_count': transaction['uploaded_count'],
            'uploaded_frames': transaction['uploaded_count'],
            'start_slot': start_slot,
            'end_slot': start_slot + transaction['uploaded_count'] - 1,
            'driver': controller.driver_name,
            'sequence_started': True,
            'sequence': transaction['sequence'],
            'message': '相位帧已写入真实 SLM 并启动序列播放',
        })
    except (TypeError, ValueError) as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except SLMSequenceUploadError as exc:
        return jsonify({
            'success': False,
            'error': str(exc),
            'uploaded_count': exc.uploaded_count,
            'uploaded_frames': exc.uploaded_count,
            'restore_failed_slots': exc.restore_failed_slots,
            'sequence_started': False,
        }), 409
    except SLMDriverError as exc:
        return jsonify({
            'success': False,
            'error': str(exc),
            'uploaded_count': 0,
            'uploaded_frames': 0,
            'sequence_started': False,
        }), 409
    except Exception as exc:  # noqa: BLE001
        return jsonify({
            'success': False,
            'error': f'USB 序列上传失败: {exc}',
            'uploaded_count': 0,
            'uploaded_frames': 0,
            'sequence_started': False,
        }), 409


# ==================== 主程序 ====================
if __name__ == '__main__':
    # 创建数据库表
    with app.app_context():
        db.create_all()
        history_columns = {
            column['name'] for column in inspect(db.engine).get_columns('generation_history')
        }
        if 'parameters_json' not in history_columns:
            print(
                'History metadata migration required. Stop the app and run '
                '`python migrate_history_schema.py` before using history or generation.'
            )
        init_default_presets()

    # 运行应用
    print("\n" + "="*60)
    print("菲涅尔透镜相位图生成系统 - Web界面")
    print("="*60)
    print("访问地址: http://127.0.0.1:5000")
    print("按 Ctrl+C 停止服务器")
    print("="*60 + "\n")

    # The reloader restarts this process on source changes and drops in-memory
    # SLAM motion jobs while requests may still be in flight.
    app.run(
        debug=False,
        use_reloader=False,
        host='0.0.0.0',
        port=5000,
        threaded=True,
    )
