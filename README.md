# Desktop Pet Translator

Desktop Pet Translator is a Windows Electron application that translates selected text and screenshot regions, records local translation vocabulary, and presents learning prompts through a Live2D mascot with a static fallback.

## Requirements

- Windows 10 or 11 on x64
- Node.js 22.12 or newer
- npm 11 or newer
- An OpenAI-compatible provider account for real translation requests

Provider API keys are stored only as operating-system `safeStorage` ciphertext. They are never committed, written to logs, or included in provider summaries.

## Development

```powershell
npm install
npm run dev
npm test
```

The build provisions checksum-verified Cubism Core and Haru sample assets into ignored local build resources. Review `ASSETS.md` before distributing a build. This project and its packaged assets are restricted to personal-only use unless the project owner separately grants permission.

## Release Validation

```powershell
npm run lint
npm run typecheck
npm test
npm run validate:release
npm run build:windows
```

- `npm run validate:release` verifies release metadata and privacy gates, reviews dependency licenses, verifies model/license outputs, and runs `npm run profile:performance`.
- `npm run profile:performance` writes `out/performance-profile.json` with measured process-tree CPU/private-memory data and clearly labeled accelerated eight-hour-equivalent idle-drift evidence.
- `npm run build:windows` produces the x64 NSIS installer under `dist/`.

For literal wall-clock idle-drift evidence, run:

```powershell
npm run profile:performance -- --real-idle-hours 8
```

See `docs/operations/performance.md` for measurement definitions and `docs/operations/release-checklist.md` for the recorded release gates.
