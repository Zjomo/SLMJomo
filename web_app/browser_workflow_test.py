"""Browser regression for conversion, simulation, history, projects, and sequences."""

import json
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

from browser_test_support import isolated_app_server


PRESET_NAME = 'Browser regression preset'


def run_browser_regression():
    console_errors = []
    page_errors = []
    failed_requests = []
    bad_responses = []
    fresnel_requests = []
    def wait_for_state(page, name, expression):
        try:
            page.wait_for_function(expression, timeout=10000)
        except Exception as error:
            state = page.evaluate(
                "() => ({spotArray: getSpotArrayProjectState(), "
                "weightInput: document.querySelector('#three_spot_weight')?.value, "
                "spotStatus: document.querySelector('#three_spot_array_status')?.textContent, "
                "generationInProgress: AppState.generationInProgress, "
                "sequenceIndex: AppState.sequenceIndex, "
                "converterOutput: document.querySelector('#converter_output_info')?.textContent, "
                "fourierInput: document.querySelector('#fourier_input_status')?.textContent})"
            )
            raise AssertionError(f'{name}: {error}; browser state={state}') from error

    with isolated_app_server() as (base_url, temporary_root):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.on(
                'console',
                lambda message: console_errors.append(message.text)
                if message.type == 'error' else None
            )
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.on(
                'requestfailed',
                lambda request: failed_requests.append(
                    f'{request.method} {request.url}: {request.failure}'
                )
            )
            page.on(
                'response',
                lambda response: bad_responses.append(
                    f'{response.status} {response.url}'
                ) if response.status >= 400 else None
            )
            page.on(
                'request',
                lambda request: fresnel_requests.append(request.url)
                if request.method == 'POST' and request.url.endswith('/api/generate') else None
            )
            page.goto(base_url, wait_until='networkidle')
            page.locator('#preset_list .preset-entry').first.wait_for()
            source_image = Path(__file__).with_name(
                '51b2910d476a104e754dc08e7efcfd1e.jpg'
            )
            assert source_image.is_file(), f'Browser test image is missing: {source_image}'
            page.locator('#input_image').set_input_files(str(source_image))
            wait_for_state(page, 'Fresnel source image upload',
                "document.querySelector('#image_preview')?.style.display === 'block' "
                "&& document.querySelector('#preview_img')?.src.startsWith('data:image/')"
            )
            page.set_viewport_size({'width': 390, 'height': 844})
            mobile_width = page.evaluate('document.documentElement.scrollWidth')
            assert mobile_width <= 390, f'390px viewport overflows to {mobile_width}px'
            page.set_viewport_size({'width': 1280, 'height': 900})
            double_ring_images = (
                '#double_ring_target_image',
                '#double_ring_phase_image',
                '#double_ring_regenerated_image',
            )
            wait_for_state(page, 'double-ring preview generation',
                "document.querySelector('#double_ring_target_image')?.src.startsWith('data:image/') "
                "&& document.querySelector('#double_ring_phase_image')?.src.startsWith('data:image/') "
                "&& document.querySelector('#double_ring_regenerated_image')?.src.startsWith('data:image/')"
            )
            for selector in double_ring_images:
                assert page.locator(selector).is_visible(), f'{selector} is not visible after generation'

            page.locator('#focus_mm').fill('1450')
            page.locator('#wavelength_nm').fill('633')
            page.locator('#x_pixels').fill('128')
            page.locator('#y_pixels').fill('128')
            page.once('dialog', lambda dialog: dialog.accept(PRESET_NAME))
            page.locator(
                "#fresnel .module-actions button[title='保存为预设']"
            ).click()
            preset = page.locator('#preset_list .preset-entry').filter(
                has_text=PRESET_NAME
            )
            preset.wait_for()
            page.locator('#focus_mm').fill('800')
            preset.locator('.preset-apply').click()
            wait_for_state(page, 'preset apply',
                "document.querySelector('#focus_mm').value === '1450' "
                "&& document.querySelector('#wavelength_nm').value === '633'"
            )
            page.once('dialog', lambda dialog: dialog.accept())
            preset.locator('.preset-delete').click()
            preset.wait_for(state='detached')

            fresnel_request_count = len(fresnel_requests)
            page.evaluate("""() => {
                const generate = document.querySelector("button[onclick='generateFresnel()']");
                generate.click();
                generate.click();
                generate.click();
            }""")
            wait_for_state(page, 'Fresnel generation',
                "document.querySelector('#phase_image')?.src.startsWith('data:image/') "
                "&& AppState.currentPatternType === 'fresnel' "
                "&& AppState.generationInProgress === false"
            )
            assert len(fresnel_requests) == fresnel_request_count + 1, (
                f'Rapid generate clicks sent {len(fresnel_requests) - fresnel_request_count} requests; expected one'
            )
            history_entry = page.locator('#history_list .history-entry').first
            history_entry.wait_for()
            page.locator('#focus_mm').fill('800')
            history_entry.click()
            wait_for_state(page, 'history restore',
                "document.querySelector('#focus_mm').value === '1450' "
                "&& document.querySelector('#phase_image')?.src.startsWith('data:image/')"
            )
            preview_image = page.locator('#phase_image')
            page.locator('.preview-tools button').nth(0).click()
            assert preview_image.evaluate('(image) => image.style.transform') == 'scale(1.2)'
            page.locator('.preview-tools button').nth(1).click()
            assert preview_image.evaluate('(image) => image.style.transform') == 'scale(1)'
            page.locator('.preview-tools button').nth(0).click()
            page.locator('.preview-tools button').nth(2).click()
            assert preview_image.evaluate('(image) => image.style.transform') == 'scale(1)'

            page.locator(
                "#fresnel-three-spots button[onclick=\"toggleModule('fresnel-three-spots')\"]"
            ).click()
            page.locator("button[onclick='addArraySpot()']").click()
            page.locator('#three_spot_weight').fill('1.7')
            page.locator('#three_spot_weight').press('Tab')
            wait_for_state(page, 'custom spot editing',
                "getSpotArrayProjectState().customized "
                "&& getSpotArrayProjectState().spots.length === 4 "
                "&& getSpotArrayProjectState().spots[3].weight === 1.7"
            )

            page.locator('#fresnel button[onclick="addToSequence()"]').click()
            assert page.locator('#sequence_list .sequence-item').count() == 1

            page.locator('#cgh_input_image').set_input_files(str(source_image))
            page.locator('#cgh_repetition').fill('1')
            page.locator('#cgh_width').fill('64')
            page.locator('#cgh_height').fill('64')
            page.locator('#cgh_light_shape').select_option('flat-square')
            page.locator("button[onclick='calculateCGH()']").click()
            wait_for_state(page, 'CGH calculation',
                "document.querySelector('#cgh_download_btn')?.disabled === false "
                "&& document.querySelector('#cgh_target_image')?.src.startsWith('data:image/') "
                "&& document.querySelector('#phase_image')?.src.startsWith('data:image/') "
                "&& AppState.cghData.cghImage === AppState.currentImageData?.image"
            )

            project_path = temporary_root / 'browser-roundtrip.slmproject.json'
            with page.expect_download() as download_info:
                page.locator('.workflow-btn').nth(2).click()
            download_info.value.save_as(str(project_path))
            saved_project = json.loads(project_path.read_text(encoding='utf-8'))
            assert saved_project['format'] == 'slmjomo-project'
            assert saved_project['spot_array']['customized'] is True
            assert len(saved_project['spot_array']['spots']) == 4
            assert saved_project['uploaded_image'].startswith('data:image/jpeg;base64,')
            assert len(saved_project['sequence']) == 1
            assert saved_project['sequence'][0]['patternType'] == 'fresnel'
            assert saved_project['current_output']['patternType'] == 'cgh'
            assert saved_project['current_output']['image'].startswith('data:image/')
            assert saved_project['cgh']['target_image'].startswith('data:image/jpeg;base64,')
            assert saved_project['cgh']['phase_image_ref'] == 'current_output'
            assert saved_project['cgh']['regenerated_image'].startswith('data:image/')
            assert saved_project['cgh']['light_shape_image'].startswith('data:image/')
            assert saved_project['cgh']['target_label'] == source_image.name

            page.locator('#focus_mm').fill('800')
            page.locator('#three_spot_weight').fill('2.3')
            page.locator('#cgh_repetition').fill('2')
            page.locator('#cgh_light_shape').select_option('gaussian')
            page.locator('#cgh_target_path').fill('replacement-target.jpg')
            page.locator('#input_image').evaluate('(input) => input.value = ""')
            page.locator("button[onclick='removeImage()']").click()
            page.locator('#sequence_list .btn-remove-seq').click()
            page.evaluate("""() => {
                AppState.cghData = {
                    targetImage: null,
                    cghImage: null,
                    regeneratedImage: null,
                    lightShapeImage: null,
                    filename: null
                };
                const target = document.querySelector('#cgh_target_image');
                target.removeAttribute('src');
                target.style.display = 'none';
                document.querySelector('#cgh_regenerate_canvas').style.display = 'none';
                document.querySelector('#cgh_light_canvas').style.display = 'none';
            }""")
            page.locator('#focus_mm').fill('800')
            page.locator("button[onclick='generateFresnel()']").click()
            wait_for_state(page, 'replacement Fresnel generation before project restore',
                "document.querySelector('#focus_mm').value === '800' "
                "&& AppState.currentPatternType === 'fresnel' "
                "&& document.querySelector('#sequence_list .sequence-item') === null "
                "&& !AppState.uploadedImage"
            )
            with page.expect_file_chooser() as chooser_info:
                page.locator('.workflow-btn').nth(1).click()
            chooser_info.value.set_files(str(project_path))
            wait_for_state(page, 'project restore',
                "document.querySelector('#focus_mm').value === '1450' "
                "&& getSpotArrayProjectState().customized "
                "&& getSpotArrayProjectState().spots.length === 4 "
                "&& getSpotArrayProjectState().spots[3].weight === 1.7 "
                "&& AppState.uploadedImage?.startsWith('data:image/jpeg;base64,') "
                "&& AppState.sequenceList.length === 1 "
                "&& AppState.sequenceList[0].patternType === 'fresnel' "
                "&& AppState.currentPatternType === 'cgh' "
                "&& AppState.currentImageData?.image === AppState.cghData.cghImage "
                "&& AppState.cghData.targetImage?.startsWith('data:image/jpeg;base64,') "
                "&& AppState.cghData.regeneratedImage?.startsWith('data:image/') "
                "&& AppState.cghData.lightShapeImage?.startsWith('data:image/') "
                "&& document.querySelector('#cgh_target_path').value === '51b2910d476a104e754dc08e7efcfd1e.jpg' "
                "&& document.querySelector('#cgh_target_image').style.display === 'block' "
                "&& document.querySelector('#cgh_regenerate_canvas').style.display === 'block' "
                "&& document.querySelector('#cgh_light_canvas').style.display === 'block'"
            )
            assert page.locator('#sequence_list .sequence-item').count() == 1
            assert page.locator('#sequence_list .seq-params').first.inner_text().startswith('fresnel:')
            assert page.locator('#image_preview').is_visible()
            assert page.locator('#preview_img').get_attribute('src') == saved_project['uploaded_image']
            assert page.locator('#phase_image').get_attribute('src') == saved_project['current_output']['image']
            assert page.locator('#cgh_target_image').get_attribute('src') == saved_project['cgh']['target_image']
            assert page.locator('#cgh_image_info').inner_text() == '已恢复项目中的 CGH 相位图'
            assert not page.locator('#cgh_download_btn').is_disabled()
            assert not page.locator('#cgh_send_btn').is_disabled()

            page.evaluate('addToSequence()')
            assert page.locator('#sequence_list .sequence-item').count() == 2
            page.locator('#play_interval').fill('100')
            page.locator('#loop_play').check()
            page.evaluate("""() => {
                window.__sequenceFrameRenders = 0;
                const display = window.displayPhaseImage;
                window.displayPhaseImage = function(image) {
                    window.__sequenceFrameRenders += 1;
                    return display(image);
                };
            }""")
            page.locator('#play_btn').click()
            page.wait_for_function('window.__sequenceFrameRenders >= 4', timeout=5000)
            page.locator("button[onclick='stopSequence()']").click()
            wait_for_state(page, 'looping sequence stop',
                "AppState.isPlaying === false "
                "&& AppState.playInterval === null "
                "&& AppState.sequenceIndex === 0"
            )
            assert not page.locator('#play_btn').is_disabled()
            assert page.locator('#pause_btn').is_disabled()

            page.locator('#bmp-converter .module-header .btn-icon').first.click()
            page.locator('#converter_input_image').set_input_files(str(source_image))
            wait_for_state(page, 'converter image upload',
                "document.querySelector('#converter_image_preview')?.style.display === 'block' "
                "&& document.querySelector('#converter_preview_img')?.src.startsWith('data:image/')"
            )
            page.locator('#converter_width').fill('64')
            page.locator('#converter_height').fill('64')
            page.locator("#bmp-converter button[onclick='convertToBmp()']").click()
            wait_for_state(page, 'BMP conversion',
                "document.querySelector('#converter_output_img')?.src.startsWith('data:image/') "
                "&& document.querySelector('#converter_download_btn')?.disabled === false"
            )
            assert '64×64' in page.locator('#converter_output_info').inner_text()
            assert '8-bit' in page.locator('#converter_output_info').inner_text()

            page.locator('#fourier-sim .module-header .btn-icon').first.click()
            page.locator('#fourier_upload_input').set_input_files(str(source_image))
            page.wait_for_function(
                "document.querySelector('#fourier_input_status')?.textContent.includes('已上传')"
            )
            page.locator('#fourier_illumination_type').select_option('gaussian')
            assert page.locator('#fourier_beam_radius_container').is_visible()
            page.locator('#fourier_beam_radius').fill('32')
            page.locator('#fourier_width').fill('64')
            page.locator('#fourier_height').fill('64')
            page.locator('#fourier_colormap').select_option('inferno')
            page.locator("#fourier-sim button[onclick='runFourierSimulation()']").click()
            wait_for_state(page, 'Fourier simulation',
                "document.querySelector('#fourier_color_img')?.src.startsWith('data:image/') "
                "&& document.querySelector('#fourier_log_img')?.src.startsWith('data:image/') "
                "&& document.querySelector('#fourier_raw_img')?.src.startsWith('data:image/') "
                "&& document.querySelector('#fourier_illumination_img')?.src.startsWith('data:image/') "
                "&& document.querySelector('#fourier_download_btn')?.disabled === false"
            )
            assert page.locator('#fourier_colormap_label').inner_text() == 'Colormap: inferno'
            assert page.locator('#fourier_illumination_img').is_visible()

            assert not console_errors, f'Browser console errors: {console_errors}'
            assert not page_errors, f'Uncaught page errors: {page_errors}'
            assert not failed_requests, f'Failed browser requests: {failed_requests}'
            assert not bad_responses, f'HTTP error responses: {bad_responses}'
            browser.close()

    return {
        'status': 'passed',
        'base_url': base_url,
        'checks': [
            'preset create, apply, and delete',
            'Fresnel generation and history parameter restore',
            'preview zoom in, out, and reset',
            'rapid Fresnel submissions are coalesced into one request',
            'project round-trip restores uploaded image, sequence, current CGH preview, and CGH results',
            'looping sequence stops and clears its playback interval',
            'BMP converter upload, grayscale conversion, preview, and download state',
            'Fourier upload, Gaussian illumination, four previews, and download state',
            'custom spot-array editing and persistence',
            '390px responsive layout without horizontal overflow',
            'double-ring target, phase, and reconstruction previews are visible',
            'console, uncaught exceptions, failed requests, and HTTP errors are clear'
        ],
        'console_errors': console_errors,
        'page_errors': page_errors,
        'failed_requests': failed_requests,
        'bad_responses': bad_responses
    }


if __name__ == '__main__':
    try:
        result = run_browser_regression()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, indent=2))
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))
