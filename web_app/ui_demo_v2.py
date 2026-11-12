"""Record the P0 core-path UI demo defined in UI_CLICK_TEST_PLAN.md v2.0.

Covers: fresnel generate -> sequence -> vortex generate -> sequence play/pause/stop
-> BMP converter upload+convert -> Fourier simulation -> simulated device connect.
Starts an isolated Flask server and writes screenshots, results, and video to a
temporary output directory.
"""
from pathlib import Path
import json
import sys
import tempfile
from playwright.sync_api import sync_playwright
from browser_test_support import isolated_app_server

ROOT = Path(__file__).resolve().parent
OUT = Path(tempfile.mkdtemp(prefix="slmjomo-ui-demo-v2-"))
OUT.mkdir(parents=True, exist_ok=True)
DEMO_IMG = ROOT / "51b2910d476a104e754dc08e7efcfd1e.jpg"


def main() -> int:
    with isolated_app_server() as (base_url, _temporary_root):
        return run_demo(base_url)


def run_demo(base_url: str) -> int:
    console_errors = []
    failed_requests = []
    steps = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800},
                                      record_video_dir=str(OUT / "video"),
                                      record_video_size={"width": 1280, "height": 800})
        page = context.new_page()
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("requestfailed", lambda req: failed_requests.append(f"{req.method} {req.url}: {req.failure}"))

        def snap(name: str):
            page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)

        def step(name: str, action):
            try:
                action()
                steps.append({"name": name, "status": "passed"})
            except Exception as exc:
                steps.append({"name": name, "status": "failed", "error": str(exc)})

        def wait_preview(selector: str, timeout: int = 60000):
            page.wait_for_function(
                "s => { const el = document.querySelector(s); return el && el.src && el.src.startsWith('data:') }",
                arg=selector, timeout=timeout)

        # P0-1 home
        # Note: the page auto-fires a double-ring preview POST ~350ms after load
        # (pro_main.js init). Let it settle so it does not collide with demo clicks.
        page.goto(base_url, wait_until="networkidle")
        page.wait_for_timeout(1500)
        snap("01_home")

        # P0-2 fresnel generate
        step("wavelength preset 633", lambda: page.locator("button[data-wl='633']").click())
        step("set fresnel parameters", lambda: (page.locator("#focus_mm").fill("800"),
                                                page.locator("#x_pixels").fill("512"),
                                                page.locator("#y_pixels").fill("512")))
        step("generate fresnel phase", lambda: page.locator("button[onclick='generateFresnel()']").click())
        step("wait fresnel preview", lambda: wait_preview("#phase_image"))
        snap("02_fresnel_result")

        # P0-3 add to sequence
        step("add fresnel to sequence", lambda: page.locator("button[onclick='addToSequence()']").click())
        snap("03_sequence_added")

        # P0-4 vortex generate + add
        step("navigate to vortex", lambda: page.locator("li[onclick=\"showModule('vortex')\"]").click())
        page.wait_for_timeout(600)
        step("set vortex parameters", lambda: (page.locator("#vortex_lnumber").fill("2"),
                                               page.locator("#vortex_width").fill("256"),
                                               page.locator("#vortex_height").fill("256")))
        step("generate vortex", lambda: page.locator("#vortex button[onclick=\"generatePattern('vortex')\"]").click())
        step("wait vortex preview", lambda: page.wait_for_function(
            "document.querySelector('#vortex_download_btn')?.disabled === false", timeout=60000))
        page.wait_for_timeout(400)
        step("add vortex to sequence", lambda: page.locator("#vortex button[onclick='addCurrentToSequence()']").click())
        snap("04_vortex_result")

        # P0-5 sequence play/pause/stop
        # Switch to the sequence window via the top menu.
        step("navigate to sequence", lambda: page.locator(".menu-item[href='#sequence-panel']").click())
        page.wait_for_timeout(400)
        step("check sequence items", lambda: page.wait_for_function(
            "AppState.sequenceList.length >= 2", timeout=5000))
        step("set interval 800ms", lambda: page.locator("#play_interval").fill("800"))
        step("play sequence", lambda: page.locator("#play_btn").click())
        # playSequence flips button states on the first interval tick
        step("wait playing state", lambda: page.wait_for_function(
            "!document.getElementById('pause_btn').disabled", timeout=5000))
        snap("05_sequence_playing")
        step("pause sequence", lambda: page.locator("#pause_btn").click())
        page.wait_for_timeout(400)
        step("stop sequence", lambda: page.locator("button[onclick='stopSequence()']").click())

        # P0-6 BMP converter
        step("navigate to bmp converter", lambda: page.locator("li[onclick=\"showModule('bmp-converter')\"]").click())
        page.wait_for_timeout(400)
        step("upload demo image", lambda: page.locator("#converter_input_image").set_input_files(str(DEMO_IMG)))
        page.wait_for_timeout(600)
        step("set bmp output 512x512", lambda: (page.locator("#converter_width").fill("512"),
                                                page.locator("#converter_height").fill("512")))
        step("convert to bmp", lambda: page.locator("#bmp-converter button[onclick='convertToBmp()']").click())
        step("wait bmp preview", lambda: page.locator("#converter_output_img").wait_for(state="visible", timeout=30000))
        snap("06_bmp_result")

        # P0-7 Fourier simulation
        step("navigate to fourier", lambda: page.locator("li[onclick=\"showModule('fourier-sim')\"]").click())
        page.wait_for_timeout(400)
        step("use current phase", lambda: page.locator("button[onclick='useCurrentPhaseForFourier()']").click())
        step("select gaussian illumination", lambda: page.locator("#fourier_illumination_type").select_option("gaussian"))
        step("set fourier output 256x256", lambda: (page.locator("#fourier_width").fill("256"),
                                                    page.locator("#fourier_height").fill("256")))
        snap("07_fourier_setup")
        step("run fourier simulation", lambda: page.locator("#fourier-sim button[onclick='runFourierSimulation()']").click())
        step("wait fourier color result", lambda: page.locator("#fourier_color_img").wait_for(state="visible", timeout=60000))
        snap("08_fourier_result")

        # P0-8 simulated device (buttons live in the fresnel window)
        step("navigate back to fresnel", lambda: page.locator("li[onclick=\"showModule('fresnel')\"]").click())
        page.wait_for_timeout(400)
        step("connect device", lambda: page.locator("button[onclick='connectDevice()']").click())
        page.wait_for_timeout(400)
        step("show on simulated SLM", lambda: page.locator("button[onclick='showOnSLM()']").click())
        page.wait_for_timeout(400)
        snap("09_device_state")

        video_path = page.video.path() if page.video else None
        context.close()
        browser.close()

    auto_preview_noise = [r for r in failed_requests if "double_ring" in r]
    real_failures = [r for r in failed_requests if "double_ring" not in r]
    result = {"base_url": base_url, "output_dir": str(OUT),
              "steps": steps, "console_errors": console_errors,
              "failed_requests": real_failures,
              "known_noise_auto_double_ring_preview": auto_preview_noise,
              "video_path": str(video_path) if video_path else None}
    (OUT / "ui_demo_v2_results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    ok = (all(s["status"] == "passed" for s in steps)
          and not console_errors and not real_failures)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
