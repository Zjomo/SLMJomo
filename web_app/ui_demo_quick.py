from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'artifacts' / 'ui_demo_quick'
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 900}, record_video_dir=str(OUT / 'video'), record_video_size={'width': 1280, 'height': 900})
    page = context.new_page()
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:5000/', wait_until='domcontentloaded', timeout=15000)
    page.screenshot(path=str(OUT / 'home.png'))
    page.locator("button[data-wl='633']").click()
    page.locator('#focus_mm').fill('800')
    page.locator('#x_pixels').fill('256')
    page.locator('#y_pixels').fill('256')
    page.locator("button[onclick='generateFresnel()']").click()
    page.wait_for_function("document.querySelector('#phase_image')?.src?.startsWith('data:')", timeout=20000)
    page.screenshot(path=str(OUT / 'fresnel.png'))
    page.locator("button[onclick='addToSequence()']").click()
    page.locator("li[onclick=\"scrollToSection('fourier-sim')\"]").click()
    page.wait_for_timeout(300)
    page.locator("#fourier-sim button[onclick=\"toggleModule('fourier-sim')\"]").click()
    page.locator("button[onclick='useCurrentPhaseForFourier()']").click()
    page.locator('#fourier_illumination_type').select_option('gaussian')
    page.screenshot(path=str(OUT / 'fourier_setup.png'))
    page.locator("button[onclick='connectDevice()']").click()
    page.locator("button[onclick='showOnSLM()']").click()
    page.screenshot(path=str(OUT / 'device.png'))
    video = page.video.path()
    context.close()
    browser.close()
result = {'video_webm': str(video), 'console_errors': errors, 'screenshots': [str(p) for p in OUT.glob('*.png')]}
(OUT / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
