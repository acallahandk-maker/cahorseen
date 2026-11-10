# Final Review Fix Report

Base commit: `84d265c829af` (`84d265c feat: add release validation and windows packaging`).

This report records the single final-review fix wave covering every Critical, Important, and Minor finding in `final-review-findings.md`.

## Findings Disposition

1. **Critical — Screenshot vocabulary privacy heuristics abort legitimate translations: fixed.** Structured image response parsing now preserves the provider's source text. Vocabulary validation remains at the translation-memory persistence boundary, where rejection produces a non-fatal memory status without discarding the completed translation. Regression coverage exercises literal `Screenshot region contains ...` text and uniform-width natural-language token sequences through the translation and memory-recording service boundaries.
2. **Critical — Clipboard restoration can be overwritten and lost: fixed.** Clipboard fallback now serializes the copy/read effects, waits for every started operation to settle, performs exactly one final restore after the last pending write/read effect, and propagates final restoration failure. Regression coverage checks actual clipboard contents after delayed writes, delayed copy failure, cancellation, and restore failure.
3. **Critical — Persistent polling and foreign foreground-window probing: fixed.** The 30-second system-state poll and Win32 foreign-window probe were removed. Battery/idle state is refreshed only at app initialization, lifecycle transitions, and explicit translation/screenshot interactions. Fullscreen, hidden-window, presentation, and active-translation suppression remain event driven. Regression coverage asserts there is no polling/probe path and exercises the production suppression callback and hidden-window state.
4. **Important — Misleading or inert privacy/history/performance settings: fixed.** `saveTranslationHistory` now gates real selection and screenshot translation-memory retention. The always-restored clipboard behavior is no longer exposed as a preference. The vocabulary storage disclosure explicitly states that source text is sent to the configured remote provider. The inert `localOnly` and `limitFrameRate` controls were removed; power-aware frame-rate limiting is disclosed as always enabled. UI and persistence round-trip regressions cover the final user-visible state.
5. **Important — Invalid vision capability probe: fixed.** Vision capability detection now sends a MIME-consistent, decoder-valid 1x1 PNG fixture. Tests assert PNG signature, IHDR dimensions, IEND marker, byte length, schema consistency, and the request sent at the provider boundary.
6. **Important — Missing `Check updates` action: fixed.** The tray menu now includes deterministic personal-build `Check updates` behavior that opens the configured HTTPS releases page, defaulting to the project's GitHub releases page. Tray menu and action behavior are regression-tested.
7. **Important — Normal Windows sandbox and installed-app viability ungated: fixed.** `scripts/smoke-installed.ps1` performs a silent NSIS installation and launches the installed executable without `--no-sandbox`, records JSON evidence, verifies the Chromium sandbox is enabled, checks renderer/window state and shutdown acknowledgement, and cleans temporary installation directories. `validate-release.ps1` invokes and validates this installed smoke gate.
8. **Important — Custom quiz frequency preferences not user-visible: fixed.** Settings now expose total and recent occurrence weights, persist them through the existing settings boundary, initialize the scheduler from stored preferences, and feed the weights into question selection. UI round-trip, persistence, and scheduler-integration regressions cover the controls and behavior.
9. **Minor — Attacker-controlled `error.name` classification: fixed.** IPC failure classification now matches concrete `ProviderError` and `SecureConfigError` instances with `instanceof`. Regression coverage includes an attacker-controlled error named `SecureConfigError` and concrete provider/config errors.

## Regression Coverage

- Added 8 focused final-review regression files with 21 tests.
- Updated legacy tests that encoded superseded behavior for response-time vocabulary rejection, pre-settling clipboard restoration, inert settings, and removed system polling/probing.
- Focused regression command:
  `node scripts/run-tests.mjs tests/integration/finalReviewConfig.test.ts tests/integration/finalReviewIpc.test.ts tests/integration/finalReviewServices.test.ts tests/integration/finalReviewSystemIntegration.test.ts tests/performance/finalReviewReleaseGate.test.ts tests/unit/finalReviewClipboard.test.ts tests/unit/finalReviewQuizPreferences.test.ts tests/unit/finalReviewSettingsQuiz.test.tsx`
- Focused result: **8 test files passed, 21/21 tests passed**.

## Verification

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- Focused regressions: passed, **8 files / 21 tests**.
- `npm test`: passed, **37 files / 426 tests total** (`35/35` memory-worker tests plus `391/391` remaining tests).
- `npm run build:windows`: passed and produced the NSIS installer.
- `npm run validate:release`: passed, including dependency review, performance profile, and the installed smoke gate.
- `npm run smoke:installed`: passed independently after the final production adjustment.
- `git diff --check`: passed.
- Temporary installed-smoke directories after cleanup: **0**.

## Installer And Packaged Smoke

- Installer: `C:\Users\yuzhu\.codex\worktrees\desktop-pet-translator\cahorseen\dist\Desktop-Pet-Translator-0.1.0-setup.exe`
- Installer size: **137093960 bytes**.
- Evidence: `C:\Users\yuzhu\.codex\worktrees\desktop-pet-translator\cahorseen\out\installed-smoke-evidence.json`
- Smoke exit code: **0**.
- Smoke success: **true**.
- Chromium sandbox disabled: **false**.
- Shutdown acknowledgement: **true**.
- Window count: **1**.
- Scenario/render result: `live2d-fallback` / `static-fallback`.
- Renderer URL was present and pointed inside the installed `app.asar`.

The packaged smoke stderr contained harmless smoke-mode IPC-handler warnings and GPU-state warnings, but the installed launch completed, retained its window, emitted valid JSON evidence, acknowledged shutdown, and exited successfully.

## Deferred Concerns

- Repository-order context previous/next navigation remains deferred.
- Modal focus trapping, focus restoration, and Escape handling remain deferred.
- Future-dated `lastUsedAt` values can still pass the 7/30-day filters.
- `QuizScheduleUpdate` remains duplicated between scheduler and database layers.
- `smokeMode.ts` remains a mixed smoke orchestration fixture.
- `evaluatePerformanceProfile` reports default thresholds when custom targets are supplied.
- Earlier review runs observed an intermittent Vitest runner startup failure immediately after `RUN`; the final focused and full-suite runs completed cleanly and did not reproduce it.
- Installed/full-flow smoke stderr can contain missing smoke IPC-handler warnings and GPU-state warnings despite a successful exit.
