# Release Checklist

<!-- dependency-license-summary {"packageCount":526,"runtimePackageCount":74,"licenseCounts":{"(MIT OR CC0-1.0)":1,"(WTFPL OR MIT)":1,"0BSD":1,"Apache-2.0":24,"BSD-2-Clause":13,"BSD-3-Clause":13,"BlueOak-1.0.0":9,"CC-BY-4.0":1,"CC0-1.0":1,"ISC":42,"MIT":413,"MIT-0":2,"MPL-2.0":2,"Python-2.0":1,"WTFPL":1,"WTFPL OR ISC":1}} -->

## Release Scope

- [x] Windows x64 NSIS packaging is configured in `package.json`.
- [x] `npm run validate:release`, `npm run profile:performance`, and `npm run build:windows` are documented in `README.md`.
- [x] Distribution is restricted to personal-only use by this project. Other use requires explicit written permission from the project owner.

## Model and License Verification

- [x] `ASSETS.md` records source URLs, commits/versions, SHA-256 checksums, modifications, rights holders, and license locations for Cubism Core and the Haru sample model.
- [x] `scripts/provision-live2d-assets.mjs --verify` is a release gate and validates generated Core, model tree, manifest, and license outputs against `config/live2d-assets.lock.json`.
- [x] Live2D proprietary Core redistribution evidence and the Haru Free Material/Sample Data terms are reviewed in `ASSETS.md`.
- [x] The Haru attribution notice is displayed by the application, sound redistribution is excluded, and user-supplied models require provenance and license recording.

## Dependency and License Review

Reviewed on 2026-11-09 with `npm query "*"`, installed package metadata, and `package-lock.json`.

- [x] 526 third-party packages were reviewed across all dependency levels.
- [x] Third-party license families: MIT (413), ISC (42), Apache-2.0 (24), BSD-2-Clause (13), BSD-3-Clause (13), BlueOak-1.0.0 (9), MPL-2.0 (2), MIT-0 (2), 0BSD (1), CC-BY-4.0 (1), CC0-1.0 (1), Python-2.0 (1), WTFPL (1), `WTFPL OR ISC` (1), `(MIT OR CC0-1.0)` (1), and `(WTFPL OR MIT)` (1).
- [x] The 74 third-party runtime packages are permissive: MIT (72), ISC (1), and BSD-3-Clause (1).
- [x] No GPL, LGPL, AGPL, or SSPL runtime dependency is present. The generated `out/dependency-license-review.json` is the machine-readable review record.
- [x] The release gate enforces an explicit approved-license policy. Runtime dependencies are restricted to the reviewed permissive/weak-notice set; MPL-2.0, CC-BY-4.0, WTFPL, and reviewed OR expressions are approved only for development dependencies.
- [x] Electron, Live2D Core, and Haru model terms are reviewed separately from npm dependency metadata.
- [x] `better-sqlite3` 13 uses Node-API and ships a Windows x64 prebuild. Electron packaging keeps `npmRebuild` disabled to avoid an unnecessary ABI-specific rebuild, while the full Electron suite loads and exercises the native module before release.
- [x] Packaging uses the checksum-installed Electron 44.10.0 distribution from `node_modules/electron/dist`, avoiding an extra runtime download during release assembly.

## Privacy and Cleanup

- [x] No API keys or secrets are stored in source, committed files, reports, or logs. Provider keys use `safeStorage` ciphertext and summaries expose only `hasApiKey`.
- [x] No screenshots or image buffers persist after tasks. Captures stay in memory, are explicitly disposed on success and failure, and the Electron gate checks for persisted image files and leaked child processes.
- [x] Temporary Electron profile and smoke directories are removed after every run.

## Performance Gates

- [x] Idle CPU is below 1%.
- [x] Translation CPU is below 15%.
- [x] Normal private memory is below 300 MB.
- [x] Screenshot peak private memory is below 450 MB.
- [x] Interaction feedback excluding network is below 200 ms.
- [x] Accelerated evidence executes all 480 declared workload cycles and remains within 25 MB without claiming a literal eight-hour run; `npm run profile:performance -- --real-idle-hours 8` is documented for real wall-clock evidence.
- [x] Animation resources reduce before sustained pressure selects the static mascot fallback.

## Commands

- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run validate:release`
- [x] `npm run build:windows`
- [x] Installer existence and byte size recorded in `.superpowers/sdd/2026-10-28-desktop-pet-translator/task-12-report.md`.
