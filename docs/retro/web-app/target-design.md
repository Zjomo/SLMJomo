# Target Design: Web App Workflows

## Target Shape

Keep Flask, the existing SQLite database, and the current numerical-generation modules. Preserve the single-page workflow until the product defines actual separate views. Keep browser-side project import defensive: validate envelope, parse image headers, enforce pixel budgets, decode, then verify decoded dimensions. Keep route tests on isolated temporary databases.

Place hardware communication behind a server-side device adapter with explicit connection state and error mapping. A UI success state must follow a successful SDK operation. Do not implement or claim this adapter until the supported hardware, driver, and vendor runtime are identified and a physical device can be tested.

## Device Integration Constraints

The repository identifies the target as Hamamatsu X15223 and includes the USB SDK manual and cdecl DLL. The manual documents BMP upload to frame-memory slots 0–818 for 1272×1024 images, followed by an explicit display-slot change; both operations report success as `1`. USB/Trigger mode selection requires a controller reboot and USB re-enumeration. The SDK declarations do not specify the character encoding expected for BMP paths, and the Web App can currently generate other dimensions and wavelength-dependent phase images. A production adapter therefore still needs physical validation of path encoding, image calibration/LUT behavior, mode transitions, slot handling, and recovery after disconnect.

## Fix Sequence

1. Close G-001 through G-007 with the focused implementations and tests already present; re-run them before browser release checks.
2. Add bounded history parameter snapshots and an additive SQLite migration; require an explicit backup-first command for an existing database (G-008 complete, live migration not run).
3. Version project schema changes for CGH target and generated outputs, share duplicated phase data, and round-trip under the image-size budget (G-009 complete).
4. Define a navigation map for the existing single-page sections. Either scroll to real sections and update active state, or remove/rename menu entries that represent absent views (G-010).
5. Reuse current in-memory main-preview and CGH output data for CGH handoff; missing source data now produces an explicit warning (G-011 complete).
6. Add the real hardware adapter only after device and SDK prerequisites are known and the device constraints above are verified on hardware. Keep simulation as a named development mode, not as an implicit device (G-012).
7. Keep reconstructed architecture decisions pending owner approval (G-013); maintain the validated Windows x64 / CPython 3.12 lock and test command while confirming other supported targets (G-014); keep the isolated Playwright workflow and P0 demo under regression (G-015).

## Protected Behavior

- Keep generated BMP names and existing API response compatibility unless a versioned API change is introduced.
- Keep existing preset/history rows intact.
- Preserve the current sequence playback and its project-file representation.
- Do not run the SQLite migration against the user's live database during development or tests. The explicit command creates a timestamped SQLite backup first; the user still chooses when to apply it.
- Do not describe simulation-only device calls as physical SLM verification.
