"""
SLM功能模块测试脚本
测试所有相位图生成API
"""

import json
from PIL import Image, ImageDraw
import io
import base64
import sys
import urllib.request
import urllib.error
from pathlib import Path

from browser_test_support import isolated_app_server

BASE_URL = None
OUTPUT_DIR = None
VERIFIED_CONVERSION_FILENAMES = set()

def test_api(endpoint, payload, description, verifier=None):
    """通用API测试函数"""
    print(f"\n{'='*60}")
    print(f"测试: {description}")
    print(f"接口: {endpoint}")
    print(f"参数: {json.dumps(payload, ensure_ascii=False, indent=2)}")

    try:
        data_bytes = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            f"{BASE_URL}{endpoint}",
            data=data_bytes,
            headers={
                'Content-Type': 'application/json',
                'Content-Length': len(data_bytes)
            },
            method='POST'
        )

        with urllib.request.urlopen(req, timeout=30) as response:
            response_data = response.read().decode('utf-8')
            data = json.loads(response_data)

            if data.get('success'):
                print(f"✅ 成功: {data.get('message', 'OK')}")
                print(f"   文件名: {data.get('filename', 'N/A')}")
                if 'image' in data:
                    print(f"   图像数据: {data['image'][:50]}...")
                if verifier and not verifier(data):
                    print("❌ 输出文件验证失败")
                    return False
                return True
            else:
                print(f"❌ 失败: {data.get('error', '未知错误')}")
                return False

    except urllib.error.HTTPError as e:
        print(f"❌ HTTP错误: {e.code}")
        print(f"   {e.read().decode('utf-8')}")
        return False
    except Exception as e:
        print(f"❌ 异常: {str(e)}")
        return False


# This is a callable helper for the standalone HTTP smoke script, not a
# pytest test function with fixture arguments.
test_api.__test__ = False


def create_test_target_image():
    """创建测试用的目标图像"""
    # 创建一个简单的十字目标图像
    img = Image.new('L', (256, 256), 0)
    pixels = img.load()

    # 画一个白色十字
    for x in range(256):
        pixels[x, 128] = 255
    for y in range(256):
        pixels[128, y] = 255

    # 转换为base64
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    buffer.seek(0)
    return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}"


def create_test_image(mode='RGB', size=(256, 256), format='PNG'):
    """创建指定格式和模式的测试图像"""
    if mode == 'RGBA':
        img = Image.new('RGBA', size, (255, 0, 0, 128))
    elif mode == 'RGB':
        img = Image.new('RGB', size, (255, 0, 0))
    elif mode == 'L':
        img = Image.new('L', size, 128)
    else:
        img = Image.new(mode, size)

    # 画一个白色圆点
    draw = ImageDraw.Draw(img)
    cx, cy = size[0] // 2, size[1] // 2
    r = min(size) // 8
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255) if mode == 'RGBA' else (255 if mode == 'L' else (255, 255, 255)))

    buffer = io.BytesIO()
    if format == 'JPEG':
        # JPEG 不支持透明通道
        if mode == 'RGBA':
            img = img.convert('RGB')
        img.save(buffer, format='JPEG')
    else:
        img.save(buffer, format=format)
    buffer.seek(0)
    return f"data:image/{format.lower()};base64,{base64.b64encode(buffer.getvalue()).decode()}"


def verify_converted_bmp(filename, expected_size=None, output_dir=None):
    """验证本次请求返回的转换文件是指定尺寸的 8-bit 灰度 BMP。"""
    output_dir = Path(output_dir or OUTPUT_DIR) if (output_dir or OUTPUT_DIR) else None
    if output_dir is None or not isinstance(filename, str):
        print("   ⚠️ 没有设置隔离输出目录")
        return False

    if not filename.startswith('converted_') or Path(filename).name != filename or not filename.endswith('.bmp'):
        print(f"   ⚠️ 转换接口返回了无效文件名: {filename}")
        return False

    if filename in VERIFIED_CONVERSION_FILENAMES:
        print(f"   ⚠️ 多次转换返回了重复文件名: {filename}")
        return False

    output_root = output_dir.resolve()
    filepath = (output_root / filename).resolve()
    if filepath.parent != output_root or not filepath.is_file():
        print(f"   ⚠️ 转换输出文件不存在或超出隔离目录: {filename}")
        return False

    try:
        with Image.open(filepath) as img:
            is_valid = img.format == 'BMP' and img.mode == 'L'
            size_ok = expected_size is None or img.size == tuple(expected_size)
            print(f"   文件验证: {filename}, format={img.format}, mode={img.mode}, size={img.size}")
            if expected_size and not size_ok:
                print(f"   ⚠️ 尺寸不匹配，期望: {expected_size}")
            if is_valid and size_ok:
                VERIFIED_CONVERSION_FILENAMES.add(filename)
                return True
            return False
    except Exception as e:
        print(f"   ⚠️ 验证失败: {str(e)}")
        return False


def run_module_checks():
    VERIFIED_CONVERSION_FILENAMES.clear()
    print("=" * 60)
    print("SLM功能模块自动化测试")
    print("=" * 60)

    results = {}

    # 1. 菲涅尔透镜
    results['fresnel'] = test_api(
        '/api/generate/fresnel',
        {
            'focal_length': 1000,
            'wavelength': 532,
            'width': 512,
            'height': 512
        },
        '菲涅尔透镜 (Fresnel Lens)'
    )

    results['fresnel_three_spots'] = test_api(
        '/api/generate/fresnel_three_spots',
        {
            'focal_length': 1000,
            'wavelength': 532,
            'spot_spacing': 1.0,
            'pixel_size_um': 12.5,
            'algorithm': 'gaussian_wgs',
            'incident_beam_diameter_mm': 5.0,
            'iterations': 20,
            'phase_direction': 'standard',
            'width': 512,
            'height': 512
        },
        '菲涅尔三点聚焦 (Horizontal Three Spots)'
    )

    results['fresnel_three_spots_dammann'] = test_api(
        '/api/generate/fresnel_three_spots',
        {
            'focal_length': 1000,
            'wavelength': 532,
            'spot_spacing': 1.0,
            'pixel_size_um': 12.5,
            'algorithm': 'dammann',
            'incident_beam_diameter_mm': 5.0,
            'phase_direction': 'standard',
            'width': 512,
            'height': 512
        },
        '菲涅尔三点聚焦 (1x3 Dammann Grating)'
    )

    results['fresnel_multi_spots'] = test_api(
        '/api/generate/fresnel_three_spots',
        {
            'focal_length': 1000,
            'wavelength': 532,
            'spot_spacing': 1.0,
            'spot_count': 5,
            'pixel_size_um': 12.5,
            'algorithm': 'uniform_grating',
            'phase_direction': 'standard',
            'width': 512,
            'height': 512
        },
        '菲涅尔自定义五点聚焦 (Uniform Phase Grating)'
    )

    # 2. 轴棱锥透镜
    results['axicon'] = test_api(
        '/api/generate/axicon',
        {
            'radius': 100,
            'width': 512,
            'height': 512
        },
        '轴棱锥透镜 (Axicon Lens)'
    )

    # 3. 闪耀光栅
    results['blaze'] = test_api(
        '/api/generate/blaze',
        {
            'period': 50,
            'angle': 45,
            'width': 512,
            'height': 512
        },
        '闪耀光栅 (Blaze Grating)'
    )

    # 4. 正弦光栅
    results['sine'] = test_api(
        '/api/generate/sine',
        {
            'period': 50,
            'angle': 30,
            'width': 512,
            'height': 512
        },
        '正弦光栅 (Sine Grating)'
    )

    # 5. 涡旋光束
    results['vortex'] = test_api(
        '/api/generate/vortex',
        {
            'lnumber': 3,
            'width': 512,
            'height': 512
        },
        '涡旋光束 (Vortex Beam)'
    )

    # 6. 随机散斑
    results['random'] = test_api(
        '/api/generate/random',
        {
            'seed': 42,
            'width': 512,
            'height': 512
        },
        '随机散斑 (Random Image)'
    )

    # 7. 分屏图案
    results['divide'] = test_api(
        '/api/generate/divide',
        {
            'grayvalue1': 0,
            'grayvalue2': 255,
            'width': 512,
            'height': 512
        },
        '分屏图案 (Divide Screen)'
    )

    # 7.5 十字测试图 - 基础
    results['cross'] = test_api(
        '/api/generate/cross',
        {
            'background_phase': 0.5,
            'stripe_phase': 0.0,
            'stripe_width': 12,
            'stripe_spacing': 30,
            'stripe_number': 3,
            'width': 512,
            'height': 512
        },
        '十字测试图 (Cross Pattern) - 基础'
    )

    # 7.6 十字测试图 - 带交叉区域相位
    results['cross_intersection'] = test_api(
        '/api/generate/cross',
        {
            'background_phase': 0.5,
            'stripe_phase': 0.0,
            'stripe_width': 16,
            'stripe_spacing': 40,
            'stripe_number': 5,
            'intersection_phase': 0.75,
            'width': 768,
            'height': 768
        },
        '十字测试图 (Cross Pattern) - 带交叉相位'
    )

    # 8. CGH GS算法
    target_image = create_test_target_image()
    results['cgh_gs'] = test_api(
        '/api/cgh/calculate',
        {
            'target_image': target_image,
            'algorithm': 'gs',
            'light_shape': 'gaussian',
            'light_size': 10,
            'iterations': 50,
            'width': 256,
            'height': 256
        },
        'CGH GS算法'
    )

    # 9. CGH OC算法
    results['cgh_oc'] = test_api(
        '/api/cgh/calculate',
        {
            'target_image': target_image,
            'algorithm': 'oc',
            'light_shape': 'flat-circle',
            'light_size': 8,
            'iterations': 50,
            'width': 256,
            'height': 256
        },
        'CGH OC算法'
    )

    # 10. CGH GS算法 - 高斯光斑转换
    results['cgh_gaussian_spots'] = test_api(
        '/api/cgh/calculate',
        {
            'target_image': target_image,
            'algorithm': 'gs',
            'light_shape': 'gaussian',
            'light_size': 10,
            'iterations': 50,
            'width': 256,
            'height': 256,
            'gaussian_spots': True,
            'spot_radius': 12
        },
        'CGH GS算法 - 高斯光斑转换'
    )

    # 11. CGH OC算法 - 高斯光斑转换
    results['cgh_oc_gaussian'] = test_api(
        '/api/cgh/calculate',
        {
            'target_image': target_image,
            'algorithm': 'oc',
            'light_shape': 'gaussian',
            'light_size': 10,
            'iterations': 50,
            'width': 256,
            'height': 256,
            'gaussian_spots': True,
            'spot_radius': 15
        },
        'CGH OC算法 - 高斯光斑转换'
    )

    # 12. BMP 转换器 - RGB PNG 转 8-bit BMP
    rgb_png = create_test_image(mode='RGB', size=(256, 256), format='PNG')
    results['convert_rgb_png'] = test_api(
        '/api/convert-to-bmp',
        {
            'image': rgb_png,
            'width': 256,
            'height': 256,
            'grayscale': True
        },
        'BMP转换器 - RGB PNG转8-bit BMP',
        verifier=lambda data: verify_converted_bmp(
            data.get('filename'), expected_size=(256, 256)
        )
    )

    # 11. BMP 转换器 - RGBA PNG 转 8-bit BMP
    rgba_png = create_test_image(mode='RGBA', size=(256, 256), format='PNG')
    results['convert_rgba_png'] = test_api(
        '/api/convert-to-bmp',
        {
            'image': rgba_png,
            'width': 512,
            'height': 512,
            'grayscale': True
        },
        'BMP转换器 - RGBA PNG转8-bit BMP',
        verifier=lambda data: verify_converted_bmp(
            data.get('filename'), expected_size=(512, 512)
        )
    )
    # 12. BMP 转换器 - JPEG 转 8-bit BMP
    jpeg = create_test_image(mode='RGB', size=(300, 400), format='JPEG')
    results['convert_jpeg'] = test_api(
        '/api/convert-to-bmp',
        {
            'image': jpeg,
            'width': 300,
            'height': 400,
            'grayscale': True
        },
        'BMP转换器 - JPEG转8-bit BMP',
        verifier=lambda data: verify_converted_bmp(
            data.get('filename'), expected_size=(300, 400)
        )
    )
    # 13. BMP 转换器 - 自定义 SLM 分辨率
    custom = create_test_image(mode='RGB', size=(512, 512), format='PNG')
    results['convert_slm_size'] = test_api(
        '/api/convert-to-bmp',
        {
            'image': custom,
            'width': 1272,
            'height': 1024,
            'grayscale': True
        },
        'BMP转换器 - 自定义SLM分辨率1272x1024',
        verifier=lambda data: verify_converted_bmp(
            data.get('filename'), expected_size=(1272, 1024)
        )
    )

    # 14. 傅里叶面模拟 - 均匀照明
    phase_img_for_fourier = create_test_image(mode='L', size=(512, 512), format='PNG')
    results['fourier_uniform'] = test_api(
        '/api/simulate/fourier',
        {
            'phase_image': phase_img_for_fourier,
            'illumination_type': 'uniform',
            'width': 512,
            'height': 512
        },
        '傅里叶面模拟 - 均匀照明'
    )

    # 15. 傅里叶面模拟 - 高斯光束照明
    results['fourier_gaussian'] = test_api(
        '/api/simulate/fourier',
        {
            'phase_image': phase_img_for_fourier,
            'illumination_type': 'gaussian',
            'beam_radius': 200,
            'width': 512,
            'height': 512
        },
        '傅里叶面模拟 - 高斯光束照明'
    )

    # 测试完成总结
    print(f"\n{'='*60}")
    print("测试结果汇总")
    print(f"{'='*60}")

    total = len(results)
    passed = sum(1 for v in results.values() if v)

    for module, success in results.items():
        status = "✅ 通过" if success else "❌ 失败"
        print(f"{module:15s} {status}")

    print(f"\n总计: {passed}/{total} 通过")

    if passed == total:
        print("🎉 所有模块测试通过！")
        return 0
    else:
        print(f"⚠️ 有 {total - passed} 个模块测试失败")
        return 1


def main():
    global BASE_URL, OUTPUT_DIR
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure:
            reconfigure(encoding='utf-8', errors='replace')
    with isolated_app_server() as (base_url, temporary_root):
        BASE_URL = base_url.rstrip('/')
        OUTPUT_DIR = temporary_root / 'output'
        print(f"隔离服务已启动: {BASE_URL}")
        print(f"测试输出目录: {OUTPUT_DIR}")
        return run_module_checks()


if __name__ == '__main__':
    exit_code = main()
    exit(exit_code)
