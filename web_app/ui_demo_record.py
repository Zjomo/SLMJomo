"""Record a reproducible UI click path and emit screenshots/results/video."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "artifacts" / "ui_demo"
OUT.mkdir(parents=True, exist_ok=True)
BASE = "http://127.0.0.1:5000/"


def main() -> int:
    console_errors = []
    failed_requests = []
    steps = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900},
                                      record_video_dir=str(OUT / "video"),
                                      record_video_size={"width": 1280, "height": 900})
        page = context.new_page()
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("requestfailed", lambda req: failed_requests.append(f"{req.method} {req.url}: {req.failure}"))

        def snap(name: str):
            page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)

        def step(name: str, action):
            try:
                action()
                steps.append({"name": name, "status": "passed"})
            except Exception as exc:  # keep later evidence even when one click fails
                steps.append({"name": name, "status": "failed", "error": str(exc)})

        page.goto(BASE, wait_until="networkidle")
        snap("01_home")
        step("wavelength preset 633", lambda: page.locator("button[data-wl='633']").click())
        step("set compact Fresnel parameters", lambda: (page.locator("#focus_mm").fill("800"),
                                                         page.locator("#x_pixels").fill("256"),
                                                         page.locator("#y_pixels").fill("256")))
        snap("02_parameters")
        step("generate Fresnel phase", lambda: page.locator("button[onclick='generateFresnel()']").click())
        page.locator("#phase_image").wait_for(state="visible", timeout=60000)
        snap("03_fresnel_result")
        step("add current result to sequence", lambda: page.locator("button[onclick='addToSequence()']").click())
        step("navigate to double ring", lambda: page.locator("li[onclick=\"scrollToSection('double-ring')\"]").click())
        page.wait_for_timeout(800)
        step("expand double ring", lambda: page.locator("#double-ring button[onclick=\"toggleModule('double-ring')\"]").click())
        step("set fast double ring demo parameters", lambda: (page.locator("#double_ring_iterations").fill("5"),
                                                               page.locator("#double_ring_width").fill("128"),
                                                               page.locator("#double_ring_height").fill("128")))
        # Keep recording deterministic; the full double-ring compute is covered by API tests.
        snap("04_double_ring")
        step("navigate to Fourier simulation", lambda: page.locator("li[onclick=\"scrollToSection('fourier-sim')\"]").click())
        page.wait_for_timeout(500)
        step("use current phase for Fourier", lambda: page.locator("button[onclick='useCurrentPhaseForFourier()']").click())
        step("select Gaussian illumination", lambda: page.locator("#fourier_illumination_type").select_option("gaussian"))
        step("set compact Fourier output", lambda: (page.locator("#fourier_width").fill("128"),
                                                     page.locator("#fourier_height").fill("128")))
        # Keep recording deterministic; Fourier compute is covered by API tests.
        snap("05_fourier")
        step("connect simulated device", lambda: page.locator("button[onclick='connectDevice()']").click())
        step("send current image to simulated SLM", lambda: page.locator("button[onclick='showOnSLM()']").click())
        snap("06_device_state")
        video_path = page.video.path() if page.video else None
        context.close()
        browser.close()

    result = {"base_url": BASE, "steps": steps, "console_errors": console_errors,
              "failed_requests": failed_requests, "video_path": str(video_path) if video_path else None}
    (OUT / "ui_demo_results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if all(s["status"] == "passed" for s in steps) and not console_errors and not failed_requests else 1


if __name__ == "__main__":
    sys.exit(main())
