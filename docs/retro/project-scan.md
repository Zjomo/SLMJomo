# Project Scan

## Scope

Reviewed the Web App, desktop double-ring generator, USB SDK diagnostic entry point, root documentation, and first-party source markers for explicit unfinished handlers. Vendor samples and generated assets were treated as references, not production application code.

## Completed Findings

- Web App presets, project files, custom spot arrays, history restore, CGH handoff, download validation, and generation dimension validation have focused tests.
- Project v2 saves CGH target/output images and the current preview under the existing image budgets. It shares the CGH phase image with the main preview when both data URLs match, and still reads v1 projects.
- History snapshots are allowlisted and bounded; image payloads are excluded. The additive SQLite migration is opt-in through `web_app/migrate_history_schema.py`, which makes a timestamped backup first. The migration has only been exercised against temporary databases.
- Desktop preview requests retain the newest parameters while work is active; queued save work completes before the latest pending preview.
- The USB diagnostic resolves its cdecl DLL from the architecture-specific bundled folder instead of an absent working-directory path.

## Remaining Requirements

- Real SLM pattern display is not integrated into the Web App or desktop generator. The existing SDK sample calls are not wired into an application workflow. Completing this requires the matching Windows runtime and driver, a physical target device, and device-backed verification.
- Calibration and settings destinations have no implemented product views or requirements.
- Focused browser regression now runs with Playwright against an isolated temporary database/output directory; the P0 workflow also passes through the same isolated server.
- Runtime dependencies remain open ranges for general installs. A clean Windows x64 / CPython 3.12 runtime and test lock is documented and passes the Web App suite; Linux/macOS still need a clean-environment validation.
- Reconstructed ADRs remain proposed work pending the project owner's requested confirmation.
