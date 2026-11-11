# Baseline Audit: Web App

## Baseline Reference

The source revision at audit start was `fd00117fb133ddbec83e467e1f0f22e94e37ab47`. The working tree already contained uncommitted implementation work from the active project task, so this is a reconstructed brownfield baseline, not a pristine pre-change checkout. Findings below distinguish that in-progress baseline from the current verification snapshot.

## Perimeter

The audit covers the browser workflows and direct Flask/SQLite boundaries in `web_app`: `templates/index_pro.html`, `static/js/pro_main.js`, `static/js/spot_array.js`, `static/js/project_image_utils.js`, `app.py`, route/algorithm tests, and the user-facing guides. It does not audit the separate desktop applications or vendor SDK binaries.

## Stack and Checks

- Flask and Flask-SQLAlchemy serve a single-page HTML/CSS/JavaScript control panel; NumPy and Pillow implement the image and optics paths (`web_app/README.md:3`, `web_app/requirements.txt:1`).
- Persistence is SQLite with preset and generation-history models (`web_app/app.py:30`, `web_app/app.py:69`).
- Python regression command: `python -B -m unittest test_fresnel_spot_array test_fresnel_three_spots test_app_routes -v`.
- JavaScript regression commands: `node test_project_image_headers.cjs`, `node test_cgh_handoff.cjs`, and `node test_spot_array_project_validation.cjs`.
- Current verification snapshot after this continuation: 26 Python tests, 18 image-header/dimension checks, four CGH handoff checks, and five spot-array atomic-validation checks pass. JavaScript syntax checks and `git diff --check` pass.
- No CI workflow, Python lock file, or package-level browser-test command was found in the repository. Browser verification for this audit was unavailable because the local browser debugging endpoint returned a connection-policy error.

## Findings

- At the reconstructed baseline, preset, project, custom-array, history-preview, input-bound, and download-route flows had already been implemented during the active task; see G-001 through G-007 in `gap-register.md` for the original gaps and fixes.
- `switchTab()` updates menu styling and emits a notification, but it does not select a view (`web_app/static/js/pro_main.js:1866`).
- The CGH “load from main” handlers now transfer the current main image into the CGH target and restore the latest CGH output into the main preview (`web_app/static/js/pro_main.js:1488`, `web_app/static/js/pro_main.js:1502`, `web_app/test_cgh_handoff.cjs:36`).
- Device connection and sending are simulations and do not call the vendor SDK (`web_app/static/js/pro_main.js:970`, `web_app/static/js/pro_main.js:990`).
- History records do not include a complete parameter payload (`web_app/app.py:69`); project serialization does not include CGH state (`web_app/static/js/pro_main.js:1940`).
- Dependency versions are unbounded above and there is no lock file (`web_app/requirements.txt:1`).
- Historical UI report claims remain useful evidence for the September 2026 flows, but it is not a current browser regression result (`web_app/UI_CLICK_TEST_REPORT.md:1`).

## Risk Notes

The user's SQLite database is an existing local data asset. Route tests now use a temporary database and compare a hash before/after within the test fixture. A separate direct hash read during this audit was denied while another process held the database open; the route suite itself passed its isolation assertion. No database migration was run.
