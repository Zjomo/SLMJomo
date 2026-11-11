# Reconstructed Specification: Web App Workflows

This document records observed behavior in the current working tree; it is not a claim about original product intent.

## Requirements

- WHEN a user saves a parameter preset, THEN the preset is persisted and appears in the sidebar for application or deletion.
- WHEN a user exports a project, THEN the versioned JSON contains supported workspace controls, the primary uploaded image, custom spot-array state, and sequence items.
- WHEN a user imports a project, THEN controls and sequences are validated before state changes, and image headers are checked against per-image and total pixel limits before browser decode.
- WHEN a user submits a custom spot array, THEN the server validates each target, generates a pattern, and returns target metadata corresponding to the generated output.
- WHEN a user selects a history item, THEN its saved phase image is fetched from the application output directory and displayed; a valid bounded parameter snapshot also restores its supported controls, while a legacy row remains output-only.
- WHEN the application adds history parameter storage to an existing SQLite database, THEN an explicit migration command backs up the file and preserves legacy rows with a null snapshot.
- WHEN a user loads a pattern from the main preview into CGH, THEN that image becomes the CGH target; when the user restores a CGH result, THEN the latest generated CGH phase image becomes the main preview and current downloadable image.
- WHEN a generation request provides width or height outside 64–4096, THEN the API rejects the request instead of silently changing its dimensions.
- WHEN a download request names a path outside the output directory, THEN the API returns not found and does not disclose that file.
- WHEN the user opens the device controls, THEN the interface can display a simulated connection/send result; there is no observed vendor SDK call in these workflows.

## Invariants

- Presets and history use SQLite models; route tests must not mutate the configured user database.
- Project files use the `slmjomo-project` format with an explicit version; v1 files remain importable and v2 files include current and CGH previews under image budgets.
- A project image is restricted by a maximum encoded size, a maximum dimension of 8192, a maximum of 16 Mi pixels per image, and a maximum of 64 Mi pixels across imported project images.
- A custom spot array contains 2–15 validated targets and uses the Gaussian WGS algorithm.
- The output route serves files only from the configured output directory.
- Device status in the UI is not proof of a physical connection or successful display.

## Known Exclusions

- CGH target state and current generated previews do not round-trip through project files.
- Legacy history rows do not contain parameter snapshots, and source images are intentionally excluded from history metadata.
- Calibration and settings do not have dedicated views; the top navigation routes only to existing sections, and CGH handoff uses in-memory images or saved v2 project data.
- Physical SLM communication and display require a separately validated vendor SDK integration.
