# ADR-0002: Treat Generated Phase and Reconstruction Images as Numerical Results

- Status: Proposed; pending project-owner review
- Date: 2026-11-11

## Context

The Web App generates phase images and Fourier/double-ring reconstructions from user-supplied dimensions and optical parameters. The README documents a 12.5 µm X15223 pixel pitch, while the numerical APIs accept multiple image dimensions and wavelengths. The vendor USB manual constrains hardware BMP upload to 1272×1024, and the repository does not contain a validated, versioned device calibration or wavelength-specific phase lookup table for the generated outputs.

## Proposed Decision

Describe generated phase images and reconstructed intensity plots as numerical outputs unless they have been transformed with a validated device calibration profile and verified on the physical SLM. Keep wavelength, pixel pitch, dimensions, and algorithm parameters explicit in saved projects and history. Do not silently rescale or calibrate an image at the hardware boundary.

## Consequences

- Fourier, double-ring, and CGH previews remain simulations and are not evidence of measured optical behavior.
- A future hardware path must validate resolution and calibration compatibility before upload and identify which calibration profile it applied.
- The project owner must confirm whether one or multiple calibration profiles, wavelengths, and device configurations are supported before that workflow is designed.

## Evidence and Open Validation

- `README.md` records the X15223 pixel pitch and target device.
- `web_app/app.py` and `web_app/static/js/pro_main.js` provide numerical generation and preview flows.
- `USB_Control_SDK/L55-0491_USB_Control_SDK.pdf` documents the device BMP dimensions.
- This proposal does not define calibration coefficients or claim a physically verified phase model.
