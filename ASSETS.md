# Asset Provenance

No third-party Cubism or Live2D model binary is committed to Git. The deterministic provisioning step in `scripts/provision-live2d-assets.mjs` downloads official archives into `node_modules/.cache/desktop-pet-translator/live2d`, verifies every locked checksum, extracts only the required files, and writes ignored build resources under `src/renderer/public/live2d/`. `npm run build`, `npm run dev`, and therefore `npm test` run this step automatically. Vite copies the verified resources into `out/renderer/live2d`, so the packaged renderer contains the real Core and model locally without embedding a remote runtime dependency.

This project, including builds containing the verified Live2D materials, is restricted to personal-only use. Distribution, commercial use, or other use requires explicit written permission from the project owner in addition to satisfying every upstream license condition recorded below.

## Cubism Core

- Official source: `https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-4-r.7.zip`
- Distribution: Live2D Cubism SDK for Web `4-r.7`
- Core version: `04.02.0004`, recorded in the distribution's `Core/CHANGELOG.md`
- Downloaded: 2026-10-29
- SDK archive SHA-256: `677c1cd27e28ec317c49e2db49acdb048523ee084d5ef5569ac7afc03628bd65`
- Extracted member: `CubismSdkForWeb-4-r.7/Core/live2dcubismcore.min.js`
- Member SHA-256: `0a3ee3db125c9aeccdcd85fce81b1174f7af47b3b681f0e7cc9038a711076007`
- Modifications: none to the Core file.
- License name: Live2D Proprietary Software License.
- License text locations: `CubismSdkForWeb-4-r.7/Core/LICENSE.md` in the official archive and `https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html`.
- Full license HTML SHA-256: `e7b4ffc6c636de2cfdd6d2eed6a4e43fa7034e7f15a0c3a15f1603dbb3b4c2b6`.
- Redistribution evidence: `Core/RedistributableFiles.txt` names `live2dcubismcore.min.js`; its SHA-256 is `d16c123688299e1e69a7f5ebc01b3bd75a8d408c024002a7d35b2aae94003f8c`.
- Packaged copies: `src/renderer/public/live2d/live2dcubismcore.min.js`, `src/renderer/public/live2d/licenses/CubismCore-LICENSE.md`, `src/renderer/public/live2d/licenses/CubismCore-RedistributableFiles.txt`, and `src/renderer/public/live2d/licenses/live2d-proprietary-software-license-agreement_en.html`.

## Haru Sample Model

- Official repository: `https://github.com/Live2D/CubismWebSamples.git`
- Commit: `b1de66b0b1f1cb881d95fb6158622aeb6a2827bd`
- Archive: `https://github.com/Live2D/CubismWebSamples/archive/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd.zip`
- Downloaded: 2026-10-29
- Archive SHA-256: `185facea379f29e19bcf99b3dac4e84c1674170b93258c3537d6577780156f1e`
- Source path: `Samples/Resources/Haru`
- Source file count: 47.
- Source tree SHA-256: `0d189c904a12364293f4c98a6415c96611bf7e4d5c7c2a9c89407e9f8963a8bd`. The hash covers UTF-8 `relativePath NUL fileSha256 LF` records sorted with the explicit `Intl.Collator('en')` comparison used by the provisioning script.
- Original `Haru.model3.json` SHA-256: `5a41969802b8f9019ca731b07d918fc137e6a61eb9943bdd3f532aeaa0936f8c`.
- Rights holder: Live2D Inc.
- License classification: Live2D Original Character, as listed by the official Terms of Use for Live2D Cubism Sample Data.
- License names: Live2D Free Material License Agreement and Terms of Use for Live2D Cubism Sample Data.
- License text locations: `https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html` and `https://www.live2d.com/eula/live2d-sample-model-terms_en.html`.
- Free Material License HTML SHA-256: `e7daa8a2a20b491fa9e530455a83faf8f4fe5876d7b85cf9d9ad1bcdddcbaf8f`.
- Sample Data terms HTML SHA-256: `fbe62bce6bcca7f2457fd3d2cc1b0a4fb635ed87090519abdc1d4895fe51dae9`.

### Modifications

- Replace the original `Idle` group with `haru_g_idle`.
- Add state aliases: `Listen -> haru_g_m15`, `Thinking -> haru_g_m01`, `Success -> haru_g_m02`, `Error -> haru_g_m03`, `Quiz -> haru_g_m04`, `Happy -> haru_g_m05`, and `Sad -> haru_g_m06`.
- Retain the four original `TapBody` motion entries.
- Remove all motion `Sound` references and omit `sounds/` from build resources so interaction cannot unexpectedly play audio. This follows the sample license's separate restriction on redistributing included sound data.
- The generated manifest SHA-256 is `3ebbb5106d6c680be3bc9b9b4f44a6fc3f9fadd2b98dd02a5c6acece1b31bc03`.
- The generated model tree has 43 files and SHA-256 `640498f623cf8fc5c68799d0273311d4e41dba9cc5467d65db82929c0a1b87ac`, using the same tree algorithm.
- The application displays the required short notice: “This content uses sample data owned and copyrighted by Live2D Inc.”

The generated model and full license texts are copied to `src/renderer/public/live2d/models/Haru` and `src/renderer/public/live2d/licenses`. The directory is ignored because the material license permits use and distribution only under its stated eligibility, purpose, notice, and restricted-act conditions. A builder must review and accept those terms and qualify as a General User or Small-Scale Enterprise User for the corresponding purpose-of-use grant.

## Runtime Packages

| Package | Version | Source | License evidence | Use |
| --- | --- | --- | --- | --- |
| `pixi.js` | `5.3.12` | `https://github.com/pixijs/pixi.js.git` | Installed package metadata declares `MIT` | Transparent Pixi renderer and ticker |
| `pixi-live2d-display` | `0.3.1` | `https://github.com/guansss/pixi-live2d-display.git` | Installed package metadata declares `MIT` | Cubism 4 model display adapter |
| `@pixi/unsafe-eval` | `5.3.12` | `https://github.com/pixijs/pixi.js.git` | Installed package metadata declares `MIT` | CSP-safe Pixi shader uniform synchronization |

Only the Cubism 4 entry `pixi-live2d-display/lib/cubism4` is loaded.

## Synthetic Test Fixture

- File: `tests/fixtures/live2d/tiny.model3.json`.
- Provenance: project-authored metadata created for Task 6 tests.
- Scope: manifest validation only. Its referenced moc, texture, expression, motion, physics, pose, display-info, user-data, and sound files are intentionally nonexistent and it is never rendered.
- License: project-authored test data with no third-party visual or model content.
- The production smoke instead uses the official Haru `model3.json`, `moc3`, two textures, expressions, physics, pose, display info, user data, and motions through `tests/electron/live2dSmoke.test.ts`.

## User-Supplied Model

Set `VITE_LIVE2D_MODEL_PATH` to a same-origin local `*.model3.json` path before `npm run dev` or `npm run build`. Keep the model folder layout intact and record its source, rights holder, license text, redistribution terms, checksum, and modifications in this file before committing it.

The loader accepts only local same-origin paths and rejects URI schemes, protocol-relative paths, drive paths, raw and percent-encoded traversal, invalid encoding, unsupported asset formats, and manifest references outside the model directory. It validates `Moc`, `Textures`, `Physics`, `Pose`, `DisplayInfo`, `Expressions`, `Motions`, `UserData`, every motion file, and every motion `Sound` reference.
