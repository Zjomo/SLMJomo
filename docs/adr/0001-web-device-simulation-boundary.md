# ADR-0001: Keep Web Device Controls Explicitly Simulated

- Status: Proposed; pending project-owner review
- Date: 2026-11-11

## Context

The Web App's device controls currently update browser state and display simulation messages. They do not call the vendor SDK. The repository identifies the target as a Hamamatsu X15223 and includes SDK DLLs and manuals, but the Web App has no verified hardware adapter. The SDK manual requires a device-specific upload and display sequence, and changing to USB/Trigger mode reboots the controller.

## Proposed Decision

Keep Web device connection, display, and CGH-send actions explicitly labeled as simulation until a server-side adapter succeeds against the supported physical device. A UI status may say "connected" or "sent" only after the corresponding SDK call succeeds. Keep SDK operations out of browser JavaScript.

## Consequences

- The current simulation remains available for development and demos, with messages that make the boundary clear.
- No browser UI or documentation may claim that generated patterns were physically displayed.
- A future adapter must handle SDK errors, device disconnects, and mode changes before enabling these actions.

## Evidence and Open Validation

- `README.md` identifies X15223 and states that Web device controls are simulated.
- `web_app/static/js/pro_main.js` implements simulated connection and display messages.
- `USB_Control_SDK/L55-0491_USB_Control_SDK.pdf` documents the vendor device operations and reboot behavior.
- This proposal does not establish physical compatibility; path encoding, calibration, and device recovery still need hardware tests.
