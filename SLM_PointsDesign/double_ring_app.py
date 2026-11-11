# -*- coding: utf-8 -*-
"""
内外圈复合光斑生成器（tkinter 独立版）
=====================================
从 web_app/app.py 提取的 SLMPatternGenerator.double_ring_phase 模块，
基于 tkinter 标准库实现桌面 GUI，无需 Flask/Web 浏览器。

功能:
  - 目标光强: 圆形孔径内 平底 + 内圈高斯峰 + 外圈(R_max 处)高斯峰
  - GS(gerchberg-saxton)迭代求解纯相位图, 输出 8-bit BMP
  - 实时预览: 截面曲线 / 目标光强 / SLM相位图 / 重建光强 / 彩色强度分布
  - 修改参数后自动防抖预览, 可另存 BMP

依赖: numpy, Pillow
"""

import os
import queue
import threading
import tkinter as tk
from datetime import datetime
from tkinter import ttk, filedialog, messagebox

import numpy as np
from PIL import Image, ImageTk

# 输出目录: 本文件同级 output_phase_patterns
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "output_phase_patterns")

# 预览图显示尺寸（像素）
PREVIEW_SIZE = 260
# 自动预览防抖延迟（毫秒）
DEBOUNCE_MS = 600


# ==================== 核心算法（提取自 web_app/app.py） ====================
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
    for name, value in (("内圈中心光强", inner_intensity),
                        ("外圈光强", outer_intensity),
                        ("圈间光强", between_intensity)):
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
    reconstructed = np.abs(np.fft.fftshift(
        np.fft.fft2(np.fft.ifftshift(np.exp(1j * phase))))) ** 2
    reconstructed /= max(float(np.max(reconstructed)), 1e-12)
    return (
        np.rint(phase_uint8).astype(np.uint8),
        np.rint(target_intensity * 255.0).astype(np.uint8),
        np.rint(reconstructed * 255.0).astype(np.uint8),
    )


def save_bmp(array, filepath):
    """保存图像 (灰度->8bit BMP, RGB->24bit BMP)"""
    if array.ndim == 3:
        Image.fromarray(array.astype(np.uint8), mode="RGB").save(filepath)
        return
    if array.dtype != np.uint8:
        array = np.clip(array, 0, 255).astype(np.uint8)
    Image.fromarray(array, mode="L").save(filepath, format="BMP")


def fft_final_intensity(phase_uint8):
    """对量化后的 SLM 相位图 (exp(j·2π·gray/255)) 做 FFT，
    返回最终远场光强预览图 (uint8, 线性归一化)。"""
    field = np.exp(1j * phase_uint8.astype(np.float64) / 255.0 * 2.0 * np.pi)
    far = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(field)))
    intensity = np.abs(far) ** 2
    intensity /= max(float(np.max(intensity)), 1e-12)
    return np.rint(np.clip(intensity, 0.0, 1.0) * 255.0).astype(np.uint8)


def apply_colormap(gray, cmap="jet"):
    """灰度图 -> RGB 伪彩色图 (默认 jet 色表, 低=蓝, 高=红)。"""
    x = np.asarray(gray, dtype=np.float64) / 255.0
    if cmap == "jet":
        r = np.clip(1.5 - np.abs(4.0 * x - 3.0), 0.0, 1.0)
        g = np.clip(1.5 - np.abs(4.0 * x - 2.0), 0.0, 1.0)
        b = np.clip(1.5 - np.abs(4.0 * x - 1.0), 0.0, 1.0)
    else:  # 灰度
        return np.asarray(gray, dtype=np.uint8)
    rgb = np.stack([r, g, b], axis=-1)
    return np.rint(rgb * 255.0).astype(np.uint8)


def output_name(params):
    """与 web 版一致的输出文件命名"""
    return (
        f"double_ring_ri{params['inner_radius']:g}_ro{params['outer_radius']:g}_"
        f"wi{params['inner_width']:g}_wo{params['outer_width']:g}_"
        f"ii{params['inner_intensity']:g}_oi{params['outer_intensity']:g}_"
        f"bi{params['between_intensity']:g}"
    )


# ==================== tkinter 界面 ====================
class DoubleRingApp:
    PARAM_DEFS = [
        # (key, 中文名, 默认值, 步长)
        ("width",              "画布宽度 (px)",        512,  1),
        ("height",             "画布高度 (px)",        512,  1),
        ("inner_radius",       "内圈半径 ri (px)",     16.0, 1),
        ("outer_radius",       "外圈峰值半径 R_max (px)", 50.0, 1),
        ("inner_width",        "内圈高斯宽度 w_in (px)",  8.0,  0.5),
        ("outer_width",        "外圈边缘宽度 w_out (px)", 10.0, 0.5),
        ("inner_intensity",    "内圈圆心光强 I_inner", 0.7,  0.01),
        ("outer_intensity",    "外圈峰值光强 I_outer", 1.0,  0.01),
        ("between_intensity",  "圈间光强 I_flat",      0.2,  0.01),
        ("iterations",         "GS 迭代次数",          10,  1),
        ("seed",               "随机种子",             2026, 1),
    ]

    def __init__(self, root):
        self.root = root
        root.title("内外圈复合光斑生成器 (SLM_PointsDesign)")
        root.minsize(1300, 700)

        self.entries = {}
        self.last_arrays = {}         # 各面板最近一次生成的 numpy 数组
        self.pending_debounce = None
        self.worker = None
        self._preview_generation = 0
        self._pending_preview = None
        self._pending_saves = []
        self._active_request_id = None
        self._next_request_id = 0

        self._build_ui()
        self.schedule_preview(immediate=True)

    # ---------- UI 构建 ----------
    def _build_ui(self):
        main = ttk.Frame(self.root, padding=8)
        main.pack(fill=tk.BOTH, expand=True)

        # 左侧参数面板
        left = ttk.LabelFrame(main, text="参数设置", padding=8)
        left.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 8))

        for key, label, default, step in self.PARAM_DEFS:
            row = ttk.Frame(left)
            row.pack(fill=tk.X, pady=2)
            ttk.Label(row, text=label, width=22).pack(side=tk.LEFT)
            var = tk.StringVar(value=str(default))
            entry = ttk.Spinbox(
                row, textvariable=var, width=9, from_=0, to=10000,
                increment=step, justify="right",
                command=lambda k=key: self.schedule_preview(),
            )
            entry.pack(side=tk.LEFT, padx=(4, 0))
            var.trace_add("write", lambda *_ , k=key: self.schedule_preview())
            self.entries[key] = var

        btn_row = ttk.Frame(left)
        btn_row.pack(fill=tk.X, pady=(14, 4))
        ttk.Button(btn_row, text="生成并保存 BMP",
                   command=self.generate_and_save).pack(fill=tk.X, pady=2)
        ttk.Button(btn_row, text="保存目标光强图",
                   command=lambda: self.save_array("target")).pack(fill=tk.X, pady=2)
        ttk.Button(btn_row, text="保存重建光强图",
                   command=lambda: self.save_array("reconstructed")).pack(fill=tk.X, pady=2)
        ttk.Button(btn_row, text="保存彩色分布图",
                   command=lambda: self.save_array("fft")).pack(fill=tk.X, pady=2)
        ttk.Button(btn_row, text="恢复默认参数",
                   command=self.reset_defaults).pack(fill=tk.X, pady=2)

        tip = ("提示: 修改任意参数后自动预览。\n"
               "目标模型: 孔径内平底 I_flat +\n"
               "内圈高斯峰(ri, w_in) + 外圈高斯峰\n"
               "(R_max, w_out)，GS 迭代求纯相位。")
        ttk.Label(left, text=tip, foreground="#666",
                  justify=tk.LEFT).pack(pady=(10, 0), anchor=tk.W)

        # 右侧预览区 (上方四联图 + 下方截面曲线)
        right = ttk.Frame(main)
        right.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # 底部: 目标光强截面曲线
        bottom = ttk.LabelFrame(right, text="目标光强截面曲线", padding=4)
        bottom.pack(side=tk.BOTTOM, fill=tk.X, pady=(8, 0))
        self.curve_canvas = tk.Canvas(bottom, bg="white",
                                      highlightthickness=0, height=180)
        self.curve_canvas.pack(fill=tk.BOTH, expand=True)
        self.curve_canvas.bind("<Configure>", self._on_curve_resize)

        # 上方: 四联图
        top = ttk.Frame(right)
        top.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        self.image_labels = {}
        preview_defs = (
            ("target", "目标光强分布"),
            ("phase", "SLM 相位图 (0~255)"),
            ("reconstructed", "重建光强"),
            ("fft", "彩色强度分布"),
        )
        for key, title in preview_defs:
            panel = ttk.LabelFrame(top, text=title, padding=4)
            panel.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=4)
            holder = ttk.Label(panel, anchor=tk.CENTER)
            holder.pack(fill=tk.BOTH, expand=True)
            self.image_labels[key] = holder

        self.status_var = tk.StringVar(value="就绪")
        ttk.Label(main, textvariable=self.status_var, relief=tk.SUNKEN,
                  anchor=tk.W).pack(fill=tk.X, side=tk.BOTTOM, pady=(6, 0))

    # ---------- 参数读取 ----------
    def collect_params(self):
        params = {}
        for key, _, default, _ in self.PARAM_DEFS:
            raw = self.entries[key].get().strip()
            if key == "seed":
                params[key] = int(float(raw)) if raw else int(default)
            elif key in ("width", "height", "iterations"):
                params[key] = int(float(raw)) if raw else int(default)
            else:
                params[key] = float(raw) if raw else float(default)
        return params

    def reset_defaults(self):
        for key, _, default, _ in self.PARAM_DEFS:
            self.entries[key].set(str(default))

    # ---------- 自动预览（防抖） ----------
    def schedule_preview(self, immediate=False):
        self._preview_generation += 1
        if self.pending_debounce is not None:
            self.root.after_cancel(self.pending_debounce)
        delay = 0 if immediate else DEBOUNCE_MS
        self.pending_debounce = self.root.after(delay, self._start_preview)

    def _start_preview(self):
        self.pending_debounce = None
        self._pending_preview = None
        try:
            params = self.collect_params()
        except (ValueError, TypeError):
            self.status_var.set("参数格式有误，请检查输入")
            return
        self._pending_preview = (self._preview_generation, params)
        self._start_pending_work()

    def _start_pending_work(self):
        if self._active_request_id is not None:
            return

        save_path = None
        if self._pending_saves:
            params, save_path, generation = self._pending_saves.pop(0)
        elif self._pending_preview is not None:
            generation, params = self._pending_preview
            self._pending_preview = None
        else:
            return

        self._next_request_id += 1
        request_id = self._next_request_id
        self._active_request_id = request_id
        if save_path:
            self.status_var.set("正在生成并保存...")
        else:
            self.status_var.set(
                f"正在计算 {params['width']}x{params['height']} "
                f"x {params['iterations']} 次迭代...")
        self.worker = threading.Thread(
            target=self._generate_worker,
            args=(params, save_path, generation, request_id),
            daemon=True,
        )
        self.worker.start()

    # ---------- 后台生成线程 ----------
    def _generate_worker(self, params, save_path, generation, request_id):
        try:
            phase, target, reconstructed = double_ring_phase(**params)
            color_intensity = apply_colormap(fft_final_intensity(phase))
        except Exception as e:
            self.root.after(0, self._on_error, str(e), save_path, generation,
                            request_id)
            return
        if save_path:
            try:
                save_bmp(phase, save_path)
            except Exception as e:
                self.root.after(0, self._on_error, f"保存失败: {e}",
                                save_path, generation, request_id)
                return
        self.root.after(0, self._on_done, params, phase, target,
                        reconstructed, color_intensity, save_path, generation,
                        request_id)

    def _finish_work(self, request_id):
        if request_id != self._active_request_id:
            return False
        self._active_request_id = None
        self.worker = None
        return True

    def _on_error(self, message, save_path, generation, request_id):
        if not self._finish_work(request_id):
            return
        if save_path or generation == self._preview_generation:
            self.status_var.set(f"错误: {message}")
            messagebox.showerror("生成失败", message)
        self._start_pending_work()

    def _on_done(self, params, phase, target, reconstructed, color_intensity,
                 save_path, generation, request_id):
        if not self._finish_work(request_id):
            return
        is_current = generation == self._preview_generation
        if is_current:
            self._show_curve(target)
            self._show_image("target", target)
            self._show_image("phase", phase)
            self._show_image("reconstructed", reconstructed)
            self._show_image("fft", color_intensity)
            self.last_arrays = {"target": target, "phase": phase,
                                "reconstructed": reconstructed,
                                "fft": color_intensity}
            if (save_path and self._pending_preview is not None
                    and self._pending_preview[0] == generation):
                self._pending_preview = None
        if save_path:
            self.status_var.set(f"已保存: {save_path}")
        elif is_current:
            self.status_var.set(
                f"预览完成 {params['width']}x{params['height']}，"
                f"迭代 {params['iterations']} 次")
        self._start_pending_work()

    def _show_image(self, key, array):
        if array.ndim == 3:
            img = Image.fromarray(array, mode="RGB")
        else:
            img = Image.fromarray(array, mode="L")
        size = (min(PREVIEW_SIZE, max(array.shape[1], 1)),
                min(PREVIEW_SIZE, max(array.shape[0], 1)))
        img = img.resize(size, Image.NEAREST)
        photo = ImageTk.PhotoImage(img)
        label = self.image_labels[key]
        label.configure(image=photo, text="")
        label.image = photo  # 防止被垃圾回收

    # ---------- 目标光强截面曲线 ----------
    def _on_curve_resize(self, _event):
        target = self.last_arrays.get("target")
        if target is not None:
            self._show_curve(target)

    def _show_curve(self, target):
        c = self.curve_canvas
        if c is None or target is None:
            return
        c.delete("all")
        if c.winfo_width() < 50:
            c.update_idletasks()
        w = max(c.winfo_width(), PREVIEW_SIZE // 2)
        h = max(c.winfo_height(), PREVIEW_SIZE // 2)
        row = target[target.shape[0] // 2].astype(np.float64)
        n = row.size

        margin_l, margin_b, margin_t, margin_r = 36, 28, 12, 10
        plot_w = w - margin_l - margin_r
        plot_h = h - margin_b - margin_t
        if plot_w < 10 or plot_h < 10:
            return
        x0, y0 = margin_l, h - margin_b

        # 坐标轴与网格
        c.create_line(x0, margin_t, x0, y0, fill="#888")
        c.create_line(x0, y0, x0 + plot_w, y0, fill="#888")
        for frac, label in ((0.25, "0.25"), (0.5, "0.5"), (0.75, "0.75"),
                            (1.0, "1.0")):
            y = y0 - frac * plot_h
            c.create_line(x0, y, x0 + plot_w, y, fill="#e0e0e0")
            c.create_text(x0 - 4, y, text=label, anchor=tk.E,
                          font=("Segoe UI", 8), fill="#666")
        c.create_text(x0 + plot_w / 2, h - 10,
                      text="水平中心截面 (像素)", font=("Segoe UI", 8),
                      fill="#666")

        # 曲线（线性插值重采样到绘图区宽度）
        xs = np.linspace(0.0, n - 1.0, plot_w)
        ys = np.interp(xs, np.arange(n, dtype=np.float64), row)
        pts = []
        for i, v in enumerate(ys):
            pts.extend((x0 + i, y0 - (v / 255.0) * plot_h))
        if len(pts) >= 4:
            c.create_line(*pts, fill="#1560bd", width=1.6)

    # ---------- 保存 ----------
    def generate_and_save(self):
        try:
            params = self.collect_params()
        except (ValueError, TypeError):
            messagebox.showerror("参数错误", "参数格式有误，请检查输入")
            return
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filepath = os.path.join(
            OUTPUT_DIR,
            f"{output_name(params)}_{timestamp}.bmp")
        self._pending_saves.append(
            (params, filepath, self._preview_generation))
        self._start_pending_work()

    def save_array(self, key):
        array = self.last_arrays.get(key)
        if array is None:
            messagebox.showinfo("提示", "请先生成预览")
            return
        filepath = filedialog.asksaveasfilename(
            defaultextension=".bmp", initialfile=f"{key}.bmp",
            filetypes=[("BMP 图像", "*.bmp"), ("PNG 图像", "*.png")])
        if not filepath:
            return
        try:
            save_bmp(array, filepath)
        except Exception as e:
            messagebox.showerror("保存失败", str(e))
            return
        self.status_var.set(f"已保存: {filepath}")


def main():
    root = tk.Tk()
    try:
        from tkinter import font  # noqa: F401  确保字体模块加载
    except Exception:
        pass
    DoubleRingApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
