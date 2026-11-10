# Post-Final Remediation Report

Base commit: `203dfb5493ec871a1d6618aa639b09a6096de60a`.

## Disposition

1. **Vision probe decoder validity: fixed.** The existing vision-provider boundary test now decodes the exact PNG data URL sent by `secureConfig.ts` through Electron `nativeImage`. The deterministic decoder fixture verifies a non-empty 1x1 bitmap, non-empty PNG re-encoding, successful re-decoding, and `data:image/png;base64,` consistency on both the source and decoded data URLs. The decoder exits with a clear error if the fixture is not a PNG data URL or cannot decode as a non-empty 1x1 PNG bitmap.
2. **Accessibility cancellation hang: fixed.** `SelectionService.captureSelectionOnce` now races the started accessibility operation against abort instead of directly awaiting it. Abort settles capture as `SelectionError('aborted')` even when the adapter ignores the signal and never settles. The operation remains observed by the race so a late rejection is handled, no clipboard effect starts after this cancellation path, and existing clipboard fallback behavior still waits for started copy/read effects before its single final restore. The immediate-empty accessibility path remains compatible with cancellation during clipboard fallback, including final restore-failure precedence.
3. **Stale installer smoke risk: fixed.** `validate-release.ps1` now records a build start timestamp, invokes `npm run build:windows` unconditionally, resolves only the exact configured installer, rejects artifacts older than the current build, records size and SHA-256, and passes that exact path to `smoke:installed`. Installed smoke evidence includes the installer path, size, and SHA-256; release validation verifies those values match the current build artifact. Regression tests reject a stale expected installer even when a newer foreign installer exists, verify exact-path size/hash evidence, and enforce the rebuild-resolve-smoke ordering.

## TDD Evidence

- Initial focused run: **3 files failed** for the intended gaps: Electron decoder harness missing, accessibility cancellation returned `hung`, and current-installer resolver missing.
- Selection red result: `settles cancellation before a signal-ignoring accessibility adapter settles` failed with `expected 'hung' to be 'rejected'`.
- Release red result: stale/current installer suite could not import `resolve-current-installer.mjs`; the wiring regression also caught a literal escaped PowerShell variable before implementation.
- Green focused run: **3 files passed, 19/19 tests passed**.
- Preserved-behavior regression run: **4 files passed, 22/22 tests passed**, including `tests/unit/finalReviewClipboard.test.ts`.
- The first full-suite attempt exposed one cancellation/restore-precedence regression in `finalReviewClipboard.test.ts`; the accessibility operation was started without an extra microtask so already-completed empty accessibility reads retain existing fallback semantics. The full suite was rerun only after the focused clipboard regression passed.

## Commands And Output

- `node scripts/run-tests.mjs tests/integration/finalReviewConfig.test.ts tests/unit/selectionService.test.ts tests/performance/releaseArtifact.test.ts`: passed, **3 files / 19 tests**.
- `node scripts/run-tests.mjs tests/integration/finalReviewConfig.test.ts tests/unit/selectionService.test.ts tests/unit/finalReviewClipboard.test.ts tests/performance/releaseArtifact.test.ts`: passed, **4 files / 22 tests**.
- `npm test`: passed; memory project **35/35**, parallel project **37 files / 395 tests**, with a fresh `electron-vite build`.
- `npm run lint`: passed, zero errors and warnings.
- `npm run typecheck`: passed for `tsconfig.node.json` and `tsconfig.web.json`.
- `npm run validate:release`: passed. Fresh performance evidence passed, Windows packaging succeeded, current-installer resolution/hash checks passed, and the exact installer was installed and smoke-tested. The first validation attempt found that `Get-FileHash` is unavailable in this PowerShell runtime; SHA-256 computation was changed to .NET `SHA256`, then validation passed.
- `npm run build:windows`: passed with `electron-builder 26.18.0`, Windows x64 NSIS output.
- `npm run smoke:installed`: passed with normal Chromium sandbox, one renderer window, shutdown acknowledgement, and exit code 0.
- `git diff --check`: passed.
- Final-tree `npm test` verification: one invocation reproduced the previously documented intermittent Vitest startup failure immediately after `RUN` with zero test output; the immediate rerun passed memory **35/35** and parallel **37 files / 395 tests**.

## Installer And Smoke Evidence

- Final installer: `C:\Users\yuzhu\.codex\worktrees\desktop-pet-translator\cahorseen\dist\Desktop-Pet-Translator-0.1.0-setup.exe`
- Final installer size: **137093487 bytes**.
- Final installer SHA-256: `cd31ae62b98d6a7977d4c670a80ff7357d3bfeda566722459da02659e95599c2`.
- Smoke evidence: `C:\Users\yuzhu\.codex\worktrees\desktop-pet-translator\cahorseen\out\installed-smoke-evidence.json`
- Smoke timestamp: `2026-11-10T03:01:32.1881105Z`.
- Smoke success: `true`; exit code: `0`; shutdown acknowledgement: `true`.
- Chromium sandbox disabled: `false`; window count: `1`.
- Scenario/render result: `live2d-fallback` / `static-fallback`.
- Renderer URL was present inside the installed `resources/app.asar`.
- The separate fresh artifact used by `npm run validate:release` was `137094109 bytes`, SHA-256 `beffd9d504b03756334a21858519f16d076b22f7c8ee53af89526a5f7507fa5d`; that run also passed its exact path/size/hash smoke gate. The subsequent required standalone `npm run build:windows` produced the final artifact above, which `npm run smoke:installed` then tested.

## Remaining Concerns

- Consecutive unsigned Electron Builder builds are not byte-identical; per-run build freshness and SHA-256 evidence now prevent stale cross-run reuse.
- Installed smoke stderr retains the previously documented smoke-mode missing-handler warnings and harmless GPU-state warnings, while the installed process still completes the renderer/window/shutdown checks successfully.
- Vitest can intermittently exit immediately after `RUN` before reporting a project; an immediate rerun has consistently completed green in this remediation.
