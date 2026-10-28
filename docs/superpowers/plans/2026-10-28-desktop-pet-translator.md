# Desktop Pet Translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows Electron desktop pet that performs selection and screenshot translation through configurable OpenAI-compatible LLM APIs while learning translated vocabulary and quizzing the user through an interactive Live2D mascot.

**Architecture:** Electron has a small privileged main process, preload-mediated typed IPC, and isolated React renderer windows. Translation, screenshot processing, SQLite access, and learning scheduling run in workers or asynchronous services so they cannot block the UI. The renderer stores presentation state separately from domain state and reports mascot state through one state machine.

**Tech Stack:** Electron, TypeScript, React, Vite, PixiJS, pixi-live2d-display with Live2D Cubism 4 SDK, `better-sqlite3`, Zod, Vitest, and Playwright Electron tests.

**Spec:** `D:\zyu\develop\llmroot\cahorseen\DESIGN.md`

## Global Constraints

- Windows 10 and Windows 11 are the supported MVP platforms.
- Use Electron + TypeScript; the first release does not support macOS or Linux.
- Never continuously monitor keyboard, clipboard, screen, or accessibility APIs; read only after an explicit shortcut.
- Preserve and restore clipboard contents in fallback selection mode; never leave user clipboard replaced by translation input.
- Store API keys only with Electron `safeStorage`; never put keys in logs, errors, history, crash reports, or plain JSON.
- Use OpenAI-compatible Chat Completions with configurable Base URL, text model, and vision model; do not hard-code unconfirmed provider URLs.
- Translation memories are local, searchable, editable, exportable, and removable; repeated text within one task counts once.
- Quiz answers are four-option multiple choice and affect later scheduling; quizzes must be skippable and pausable.
- Idle target is CPU below 1%; translation target is CPU below 15%; interaction feedback is below 200 ms excluding network time.
- Render the mascot at 30 FPS normally and at 10 FPS or paused when idle, hidden, obscured, on battery, or in a fullscreen app.
- Memory target is below 300 MB normally and below 450 MB during screenshots; 8-hour idle growth must stay within 25 MB.
- Do not retain full screenshots after a task; limit image dimensions and context lengths before sending requests.
- The product must use an original chubby-fish character and legally licensed Live2D SDK and model assets.

## File Structure

- `package.json`: scripts, dependency versions, Electron packaging, and test entry points.
- `electron.vite.config.ts`, `tsconfig*.json`: renderer/main/preload builds and strict TypeScript configuration.
- `src/shared/contracts.ts`: Zod schemas and TypeScript types shared across processes.
- `src/shared/domainState.ts`: mascot and translation state machine types and transitions.
- `src/main/index.ts`: application lifecycle only.
- `src/main/ipcRouter.ts`: typed IPC registration and sender authorization.
- `src/main/services/secureConfig.ts`: provider settings and `safeStorage` secret handling.
- `src/main/services/openAiClient.ts`: OpenAI-compatible text and vision requests.
- `src/main/services/selectionService.ts`: safe one-shot selection capture and clipboard restoration.
- `src/main/services/screenshotService.ts`: region capture, image limits, and cache disposal.
- `src/main/services/memoryDatabase.ts`: worker-backed SQLite schema, transactions, occurrence counting, and exports.
- `src/main/services/quizScheduler.ts`: frequency-aware due-item selection and spaced intervals.
- `src/main/services/performanceGovernor.ts`: frame-rate modes and background suppression.
- `src/main/systemIntegration.ts`: shortcuts, tray, fullscreen detection, and power state.
- `src/main/workers/translationWorker.ts`: non-blocking translation task execution.
- `src/main/workers/memoryWorker.ts`: SQLite operations outside the Electron main event loop.
- `src/preload/index.ts`: minimal typed bridge; exposes no Node primitives.
- `src/renderer/pet/PetWindow.tsx`: transparent mascot window.
- `src/renderer/pet/Live2DStage.tsx`: Cubism loading and animation parameter mapping.
- `src/renderer/pet/QuizBubble.tsx`: question, four answers, feedback, skip, and pause controls.
- `src/renderer/translation/TranslationBubble.tsx`: result, copy, pin, retry, and language details.
- `src/renderer/screenshot/RegionSelector.tsx`: fullscreen region-selection overlay.
- `src/renderer/settings/SettingsWindow.tsx`: providers, shortcuts, memory, heat, privacy, and performance settings.
- `src/renderer/learning/VocabularyHeatView.tsx`: ranking, filters, trends, and context drill-down.
- `tests/unit`: pure service and state-machine tests.
- `tests/integration`: SQLite, IPC, provider, and worker tests.
- `tests/electron`: packaged-process smoke and core user-flow tests.
- `tests/electron/fixtures/model`: a tiny test-only licensed or synthetic Live2D fixture.

## Review Focus

- Malformed, empty, rate-limited, timed-out, or non-JSON provider responses must produce a clear recoverable error and no secret leakage; pinned in Task 3.
- Selection capture must preserve the original clipboard even when reading or translation fails; pinned in Task 4.
- Screenshot selection, cancellation, failures, and oversized images must release memory and must not persist screen content; pinned in Task 5.
- Memory deduplication, frequency updates, deletion, pause, and off-device privacy must behave exactly as the UI claims; pinned in Tasks 8 and 9.
- Hidden, idle, fullscreen, battery, and low-performance conditions must throttle animation and background work; pinned in Tasks 10 and 12.

---

### Task 1: Application Scaffold and Process Boundaries

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/App.tsx`
- Test: `tests/electron/appSmoke.test.ts`

**Interfaces:**
- Produces: `window.desktopPet.ping(): Promise<{ version: string }>` through preload.

- [ ] **Step 1: Write failing smoke test**

Test `tests/electron/appSmoke.test.ts::starts_without_node_exposure`: launch Electron with Playwright, assert the main window loads, `window.desktopPet.ping()` resolves, and `window.require` and `window.process` are undefined.

- [ ] **Step 2: Create the Electron-Vite-TypeScript scaffold**

Use strict TypeScript, separate `main`, `preload`, and `renderer` builds, and expose only a Zod-validated `ping` channel. Keep `src/main/index.ts` limited to startup and shutdown.

- [ ] **Step 3: Run scaffold verification**

Run: `npm test -- tests/electron/appSmoke.test.ts`
Run: `npm run typecheck`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add package.json package-lock.json electron.vite.config.ts tsconfig*.json src tests && git commit -m "chore: scaffold desktop pet app"`

### Task 2: Shared Contracts and Mascot State Machine

**Files:**
- Create: `src/shared/contracts.ts`, `src/shared/domainState.ts`
- Test: `tests/unit/domainState.test.ts`, `tests/unit/contracts.test.ts`

**Interfaces:**
- Produces: `MascotState`, `TranslationTask`, `ProviderConfig`, `MemoryEntry`, `QuizQuestion`; `transitionMascotState(current, event): MascotState`.
- Produces: `ProviderSummary`, `ConnectionTestResult`, `SelectionCapture`, `ScreenBounds`, `CapturedImage`, `MascotHandle`, `HeatStatistic`, `QuizFeedback`, `PerformanceMode`.
- Field contracts: `ProviderSummary` exposes `id`, `name`, `baseUrl`, `hasApiKey`, `textModel`, `visionModel`; `TranslationTask` exposes `id`, `status`, `sourceText`, `translatedText`, `targetLanguage`, `error?`; `MemoryEntry` exposes `id`, `sourceText`, `normalizedSource`, `translatedText`, language pair, occurrence/timestamps, and quiz interval fields; `QuizQuestion` exposes `id`, `prompt`, `contextHint`, and `options`, while `QuizFeedback` exposes `correct`, `correctOptionIndex`, and `nextDueAt`.

- [ ] **Step 1: Write failing contract and transition tests**

Assert rejected provider payloads, unknown mascot transitions, and valid transitions for `idle -> listening -> thinking -> success|error`, plus quiz-specific `idle -> quizzing -> happy|sad -> idle`.

- [ ] **Step 2: Implement strict schemas and deterministic state transitions**

Use Zod schemas at every IPC boundary and one pure transition function. Do not allow renderer input to cast arbitrary data into domain types.

- [ ] **Step 3: Run unit tests and typecheck**

Run: `npm test -- tests/unit/domainState.test.ts tests/unit/contracts.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/shared tests/unit && git commit -m "feat: add typed contracts and mascot states"`

### Task 3: Secure Provider Configuration and LLM Client

**Files:**
- Create: `src/main/services/secureConfig.ts`, `src/main/services/openAiClient.ts`
- Modify: `src/main/ipcRouter.ts`
- Test: `tests/integration/secureConfig.test.ts`, `tests/integration/openAiClient.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` from Task 2.
- Produces: `saveProvider(config): Promise<void>`, `getProviderSummaries(): Promise<ProviderSummary[]>`, `testProvider(capability: "text" | "vision"): Promise<ConnectionTestResult>`, `translateText(request, signal): Promise<TranslationResult>`, `translateImage(request, signal): Promise<TranslationResult>`.

- [ ] **Step 1: Write failing tests for secrets and provider errors**

Assert API keys are encrypted at rest and masked in summaries; empty/malformed/rate-limited/timeout responses return typed errors without response headers, keys, or secrets; abort signals cancel requests.

- [ ] **Step 2: Implement provider presets and OpenAI-compatible calls**

Provide DeepSeek and Mimo preset definitions without unconfirmed endpoint constants; users can edit Base URL and models. Validate Base URL, use bounded timeouts, and keep text and vision model IDs separate.

- [ ] **Step 3: Run provider integration tests**

Run: `npm test -- tests/integration/secureConfig.test.ts tests/integration/openAiClient.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main tests/integration && git commit -m "feat: add secure llm provider configuration"`

### Task 4: Selection Translation

**Files:**
- Create: `src/main/services/selectionService.ts`, `src/main/workers/translationWorker.ts`
- Modify: `src/main/ipcRouter.ts`, `src/renderer/translation/TranslationBubble.tsx`
- Test: `tests/unit/selectionService.test.ts`, `tests/integration/selectionTranslation.test.ts`

**Interfaces:**
- Consumes: `translateText(request, signal)`.
- Produces: `captureSelectionOnce(): Promise<SelectionCapture>`, `translateSelection(): Promise<TranslationTask>`.

- [ ] **Step 1: Write failing selection tests**

Mock accessibility success, clipboard fallback success, empty selection, clipboard read failure, cancellation, and translation failure. Assert clipboard contents are restored in every exit path and repeated text in one task is counted once by the caller.

- [ ] **Step 2: Implement one-shot selection and non-blocking translation**

Read selection only after the shortcut; prefer accessibility selection and fall back to clipboard without replacing clipboard during accessibility mode. Run request handling outside the event loop and stream results through typed IPC.

- [ ] **Step 3: Run selection tests and typecheck**

Run: `npm test -- tests/unit/selectionService.test.ts tests/integration/selectionTranslation.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main src/renderer tests && git commit -m "feat: add selection translation"`

### Task 5: Screenshot Translation

**Files:**
- Create: `src/main/services/screenshotService.ts`
- Create: `src/renderer/screenshot/RegionSelector.tsx`
- Modify: `src/renderer/translation/TranslationBubble.tsx`, `src/main/workers/translationWorker.ts`
- Test: `tests/unit/screenshotService.test.ts`, `tests/integration/screenshotTranslation.test.ts`, `tests/electron/screenshotUi.test.ts`

**Interfaces:**
- Consumes: `translateImage(request, signal)`.
- Produces: `captureRegion(bounds: ScreenBounds): Promise<CapturedImage>`, `translateScreenshot(bounds: ScreenBounds): Promise<TranslationTask>`, `disposeCapturedImage(image): void`.

- [ ] **Step 1: Write failing screenshot tests**

Assert region selection and keyboard cancellation, clipping, image limit enforcement, vision success, unsupported-vision typed error, cache disposal, and no screenshot file persistence.

- [ ] **Step 2: Implement region capture and image translation**

Capture only after shortcut, crop to the requested region, downscale to the configured maximum dimension, encode once, and release buffers after request completion or cancellation. Do not implement resident OCR in the MVP.

- [ ] **Step 3: Run screenshot tests and typecheck**

Run: `npm test -- tests/unit/screenshotService.test.ts tests/integration/screenshotTranslation.test.ts tests/electron/screenshotUi.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main src/renderer tests && git commit -m "feat: add screenshot translation"`

### Task 6: Live2D Mascot Runtime and Interaction

**Files:**
- Create: `src/renderer/pet/PetWindow.tsx`, `src/renderer/pet/Live2DStage.tsx`, `src/main/services/performanceGovernor.ts`
- Test: `tests/electron/live2dSmoke.test.ts`, `tests/unit/performanceGovernor.test.ts`

**Interfaces:**
- Consumes: `transitionMascotState(current, event)`.
- Produces: `loadMascotModel(modelPath): Promise<MascotHandle>`, `setMascotState(handle, state): Promise<void>`, `targetFrameRate(context): 30 | 10 | 0`.

- [ ] **Step 1: Write failing model and throttling tests**

Using the tiny test fixture, assert model load, mapping for `thinking`, `success`, `error`, `quizzing`, `happy`, and `sad`, and frame-rate values for normal, idle/hidden/battery, and paused/fullscreen states.

- [ ] **Step 2: Implement Pixi Live2D rendering and performance governor**

Load Cubism assets locally, map state changes to parameter/action layers, cap the default loop at 30 FPS, pause the loop when the window is hidden or suppressed, and fall back to a static mascot when model loading fails.

- [ ] **Step 3: Run Live2D smoke and governor tests**

Run: `npm test -- tests/electron/live2dSmoke.test.ts tests/unit/performanceGovernor.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main src/renderer tests && git commit -m "feat: add live2d mascot runtime"`

### Task 7: Translation Bubble and Settings UI

**Files:**
- Create: `src/renderer/translation/TranslationBubble.tsx`, `src/renderer/settings/SettingsWindow.tsx`
- Modify: `src/main/ipcRouter.ts`, `src/main/index.ts`
- Test: `tests/electron/translationUi.test.ts`, `tests/electron/settingsUi.test.ts`

**Interfaces:**
- Consumes: provider service and translation task contracts from Tasks 3-5.
- Produces: renderer IPC methods `translateSelection`, `translateScreenshot`, `saveProvider`, `testProvider`, `copyTranslation`, `speakTranslation`, `retryTranslation`.

- [ ] **Step 1: Write failing UI flow tests**

Assert streaming result rendering, copy/speak/pin/retry actions, provider CRUD, secret masking, text/vision connection tests, hotkey capture validation, and recoverable error presentation.

- [ ] **Step 2: Implement result and settings windows**

Keep secrets write-only after save unless the user explicitly replaces a key. Keep result windows lightweight and destroy their image resources after display.

- [ ] **Step 3: Run Electron UI tests and typecheck**

Run: `npm test -- tests/electron/translationUi.test.ts tests/electron/settingsUi.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main src/renderer tests && git commit -m "feat: add translation result and settings ui"`

### Task 8: SQLite Vocabulary Memory and Heat Statistics

**Files:**
- Create: `src/main/services/memoryDatabase.ts`
- Create: `src/main/workers/memoryWorker.ts`
- Modify: `src/main/workers/translationWorker.ts`, `src/renderer/learning/VocabularyHeatView.tsx`
- Test: `tests/integration/memoryDatabase.test.ts`, `tests/unit/heatStatistics.test.ts`

**Interfaces:**
- Consumes: completed `TranslationTask`.
- Produces: `recordTranslation(task): Promise<void>`, `queryHeat(filter): Promise<HeatStatistic[]>`, `listEntries(query): Promise<MemoryEntry[]>`, `updateEntry(id, patch): Promise<void>`, `deleteEntries(ids): Promise<void>`, `exportEntries(format): Promise<string>`, `setMemoryEnabled(enabled): Promise<void>`.

- [ ] **Step 1: Write failing memory tests**

Assert one count per normalized entry per task, stable IDs across repeats, correct frequency and recent-frequency results, language/time filters, pause behavior, edit/delete/export, transaction rollback, and deletion of all related occurrences.

- [ ] **Step 2: Implement SQLite repository and heat queries**

Run `better-sqlite3` in `memoryWorker`, use WAL mode, indexed normalized source/language/timestamp fields, batched transactional writes, and query-time recent counts. Never store API keys or full screen captures in this database.

- [ ] **Step 3: Run memory tests and typecheck**

Run: `npm test -- tests/integration/memoryDatabase.test.ts tests/unit/heatStatistics.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main src/renderer tests && git commit -m "feat: add local vocabulary memory and heat stats"`

### Task 9: Vocabulary History and Heat UI

**Files:**
- Modify: `src/renderer/settings/SettingsWindow.tsx`, `src/renderer/learning/VocabularyHeatView.tsx`
- Test: `tests/electron/vocabularyUi.test.ts`

**Interfaces:**
- Consumes: memory repository methods from Task 8.
- Produces: UI actions `searchEntries`, `filterHeat`, `openContext`, `editEntry`, `deleteEntry`, `exportEntries`, `toggleMemory`.

- [ ] **Step 1: Write failing vocabulary UI tests**

Assert ranking order, frequency trend, 7/30/all-time filters, language-pair filtering, context navigation, search, edit, delete confirmation, CSV/JSON export, pause, and visible local-only privacy status.

- [ ] **Step 2: Implement virtualized vocabulary views**

Virtualize long lists, debounce searches, keep charts cheap and accessible, and never block the mascot while rendering statistics.

- [ ] **Step 3: Run vocabulary UI tests**

Run: `npm test -- tests/electron/vocabularyUi.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/renderer tests && git commit -m "feat: add vocabulary heat and history ui"`

### Task 10: Frequency-Aware Quiz Scheduler and Quiz UI

**Files:**
- Create: `src/main/services/quizScheduler.ts`, `src/renderer/pet/QuizBubble.tsx`
- Modify: `src/main/services/memoryDatabase.ts`, `src/main/systemIntegration.ts`
- Test: `tests/unit/quizScheduler.test.ts`, `tests/electron/quizUi.test.ts`

**Interfaces:**
- Consumes: `MemoryEntry`, `recordTranslation`, and mascot transitions.
- Produces: `selectQuizQuestions(count): Promise<QuizQuestion[]>`, `recordQuizAnswer(questionId, optionIndex): Promise<QuizFeedback>`, `setQuizPreferences(preferences): Promise<void>`.

- [ ] **Step 1: Write failing scheduler and quiz UI tests**

Assert context hints, four options with one answer, higher-frequency due entries win, custom frequency preferences, correct answers progress intervals `1 -> 3 -> 7 -> 14` days, wrong answers return to 1 day, skip postpones, pause stops selection, and fullscreen/translation/intense-input suppression prevents interruptions.

- [ ] **Step 2: Implement deterministic scheduling and mascot quiz interaction**

Select from local memory only. Use stable distractor candidates from other entries and generate no network request when enough local choices exist. Map correct, wrong, skipped, and paused events to mascot states.

- [ ] **Step 3: Run quiz tests and typecheck**

Run: `npm test -- tests/unit/quizScheduler.test.ts tests/electron/quizUi.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main src/renderer tests && git commit -m "feat: add vocabulary quizzes and mascot feedback"`

### Task 11: System Integration and Suppression Rules

**Files:**
- Modify: `src/main/systemIntegration.ts`, `src/main/services/performanceGovernor.ts`, `src/renderer/settings/SettingsWindow.tsx`
- Test: `tests/integration/systemIntegration.test.ts`, `tests/electron/suppression.test.ts`

**Interfaces:**
- Consumes: `targetFrameRate(context)` and quiz/translation suppression contracts.
- Produces: `registerShortcuts(map): Promise<void>`, `setSuppressionPolicy(policy): Promise<void>`, `getPerformanceMode(): PerformanceMode`.

- [ ] **Step 1: Write failing shortcut and suppression tests**

Assert configurable unique shortcuts, invalid/conflicting keys, tray show/settings/pause-resume/exit, clean shutdown without leaked processes, fullscreen and presentation suppression, battery frame-rate reduction, suspend/resume cleanup, and one-shot-only system reads.

- [ ] **Step 2: Implement Windows system integration**

Use Electron global shortcuts and tray APIs, Windows fullscreen detection, `powerMonitor` lifecycle events, and a shared suppression policy. The service must not install persistent keyboard, clipboard, screen, or accessibility hooks.

- [ ] **Step 3: Run integration and Electron suppression tests**

Run: `npm test -- tests/integration/systemIntegration.test.ts tests/electron/suppression.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

Run: `git add src/main src/renderer tests && git commit -m "feat: integrate shortcuts tray and performance suppression"`

### Task 12: Performance Validation, Packaging, and Release Gates

**Files:**
- Create: `tests/performance/resourceProfile.test.ts`, `scripts/validate-release.ps1`
- Modify: `package.json`, `README.md`, `docs/operations/performance.md`
- Test: `tests/electron/fullFlow.test.ts`

**Interfaces:**
- Consumes: all prior application contracts.
- Produces: `npm run validate:release`, `npm run profile:performance`, `npm run build:windows`.

- [ ] **Step 1: Write failing release and end-to-end tests**

Assert selection translation, screenshot translation, provider errors, memory heat updates, quiz answer scheduling, secret masking, pause behavior, and app shutdown without leaked child processes or persisted screenshots.

- [ ] **Step 2: Implement release validation and performance profiling**

Measure idle and active CPU, normal/peak private memory, interaction latency, and 8-hour memory drift. Automatically reduce animation resources before falling back to a static mascot. Record model/license verification and dependency/license review in the release checklist.

- [ ] **Step 3: Run full verification**

Run: `npm run lint && npm run typecheck && npm test && npm run validate:release && npm run build:windows`
Expected: all commands PASS and produce a Windows installer.

- [ ] **Step 4: Commit**

Run: `git add package.json README.md docs tests scripts && git commit -m "feat: add release validation and windows packaging"`
