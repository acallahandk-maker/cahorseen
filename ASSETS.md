# Asset Provenance

## Production Mascot

No production Live2D model, texture, motion, audio, or Cubism runtime binary is committed. No third-party model license was verified during Task 6, so the application ships only an original static mascot rendered as inline SVG in `src/renderer/pet/Live2DStage.tsx`. That fallback is project-authored code with no third-party visual source.

Any future production model must be added to this file before commit with its original source URL, author or rights holder, exact license name and text location, permitted redistribution terms, download date, and all local modifications. Personal use alone is not redistribution permission.

## Runtime Packages

| Package | Version | Source | License evidence | Use |
| --- | --- | --- | --- | --- |
| `pixi.js` | `5.3.12` | `https://github.com/pixijs/pixi.js.git` | Installed `node_modules/pixi.js/package.json` declares `MIT` | Transparent Pixi renderer and frame ticker |
| `pixi-live2d-display` | `0.3.1` | `https://github.com/guansss/pixi-live2d-display.git` | Installed `node_modules/pixi-live2d-display/package.json` declares `MIT` | Cubism 4 model parsing and Live2D display adapter |

The renderer imports only `pixi-live2d-display/lib/cubism4`, so the Cubism 2 runtime is neither loaded nor required.

## Synthetic Test Fixture

- File: `tests/fixtures/live2d/tiny.model3.json`
- Provenance: project-authored synthetic manifest created for Task 6.
- Contents: metadata only. Its referenced `.moc3`, texture, and motion files do not exist and it is never rendered as a visual asset.
- Scope: `tests/electron/live2dSmoke.test.ts` only. The `"FixtureOnly": true` marker prevents mistaking it for a production model.
- License: project-authored test data containing no third-party visual or model content.

## User-Supplied Local Model

The strict loader accepts local same-origin paths only. To use a Live2D mascot:

1. Obtain a Cubism 4 Core file named `live2dcubismcore.min.js` from a Live2D Cubism SDK distribution that you are licensed to use.
2. Place it at `src/renderer/public/live2d/live2dcubismcore.min.js`. Do not commit or redistribute it unless its license explicitly permits that action and the permission is recorded here.
3. Obtain a Cubism 4 model whose license permits your intended use. Keep its complete folder structure and license file.
4. Place the folder at `src/renderer/public/live2d/models/<model-name>/`. Its `.model3.json`, `.moc3`, textures, expressions, physics, pose, and motions must remain in the same relative layout.
5. Set `VITE_LIVE2D_MODEL_PATH=/live2d/models/<model-name>/<file>.model3.json` before running `npm run build` or `npm run dev`.
6. Record the model's source, rights holder, license, and modifications in this file before committing any copied model asset.

The loader rejects remote URLs, drive paths, path traversal, query strings, fragments, non-`.model3.json` manifests, non-`.moc3` model references, unsupported textures, and unsupported motion files. Manifest asset references must stay relative to the model directory.

For complete state animations, provide these motion groups and parameter IDs in the supplied model:

| Mascot state | Motion group | Parameters |
| --- | --- | --- |
| `idle` | `Idle` | `ParamAngleX`, `ParamAngleY`, `ParamBrowLY`, `ParamBrowRY`, `ParamEyeLOpen`, `ParamEyeROpen`, `ParamMouthOpenY`, `ParamMouthForm` |
| `listening` | `Listen` | Same parameter set |
| `thinking` | `Thinking` | Same parameter set |
| `success` | `Success` | Same parameter set |
| `error` | `Error` | Same parameter set |
| `quizzing` | `Quiz` | Same parameter set |
| `happy` | `Happy` | Same parameter set |
| `sad` | `Sad` | Same parameter set |

If the model or Cubism Core cannot load, the original static mascot remains visible and the ticker is not started for the failed model.
