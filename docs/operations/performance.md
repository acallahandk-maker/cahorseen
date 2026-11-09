# Performance Validation

## Product Targets

| Metric | Release target |
| --- | ---: |
| Idle CPU | below 1% |
| Translation CPU | below 15% |
| Normal private memory | below 300 MB |
| Screenshot peak private memory | below 450 MB |
| Interaction feedback excluding network | below 200 ms |
| Eight-hour idle private-memory growth | at most 25 MB |

`npm run profile:performance` runs on Windows. Idle CPU is calculated from `Win32_Process` user and kernel time only across a dedicated no-work interval. Active CPU is read from Electron `app.getAppMetrics()` immediately around the production selection and screenshot work window, with no deliberate sleeps or post-workload tail in that window. Normal private memory is the Electron process total before active work. Screenshot peak private memory is sampled from the same trusted Electron metric at 1 ms intervals while a real `ScreenshotService` capture is retained by its translation workload.

The repeatable profile harness uses Chromium software rendering (`--disable-gpu`) so private-byte and CPU measurements do not depend on a hardware GPU. The full-flow release test separately boots the model with SwiftShader and exercises animation reduction, static fallback, and reload recovery under pressure.

Interaction latency is measured from a renderer `pointerdown` event to the next rendered frame, excluding provider network time.

## Accelerated Drift Evidence

The default profile executes 480 local vocabulary-maintenance cycles and records process private bytes after every cycle. The model declares one virtual minute per cycle, so 480 executed cycles cover an eight-hour-equivalent workload model. The report labels this evidence `accelerated-workload-cycles`, records `executedCycles: 480`, and never converts a short wall-clock interval into an eight-hour measurement.

This deterministic accelerated evidence is not a literal eight-hour measurement. Use the real-run command when wall-clock evidence is required:

```powershell
npm run profile:performance -- --real-idle-hours 8
```

That command samples once per minute for eight hours and labels the drift result `real-wall-clock` with `measuredHours: 8`. A shorter diagnostic run can use `--real-idle-hours 0.1`; only the requested wall-clock duration is claimed.

## Mascot Pressure Policy

The renderer receives process private bytes through the trusted `desktop-pet:resource-pressure-get` IPC boundary, backed by Electron `app.getAppMetrics()`. Recent interaction latency is measured from input event to rendered frame and consumed once at each pressure decision. Under moderate pressure the Live2D model remains loaded while automatic interaction is disabled and the ticker drops to the idle frame rate. Sustained peak private-memory pressure or critical interaction latency counts toward the three consecutive critical-pressure samples that select the static mascot, so animation resources are reduced first. When pressure clears, the static fallback is removed and the Live2D model is reloaded through the normal model lifecycle.
