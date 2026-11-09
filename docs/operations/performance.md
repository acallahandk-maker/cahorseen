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

`npm run profile:performance` measures the Electron process tree on Windows. CPU is derived from `Win32_Process` user and kernel time deltas, private memory is summed over the root and descendants, normal memory is the median of the idle interval, and peak memory is the maximum measured process-tree private byte count. Interaction latency is measured through a local synthetic provider, so the result excludes network time.

## Accelerated Drift Evidence

The default profile runs a fixed 126-second accelerated sampling window and maps its observed process-tree memory samples uniformly across an eight-hour-equivalent interval. The report labels this as `accelerated-8-hour-equivalent`, records the actual sample count, equivalent sample spacing, and sampled wall-clock duration, and does not claim that eight literal hours were measured. The growth value is calculated from observed process-tree private-memory samples in the generated `out/performance-profile.json`; it is not a synthetic growth curve.

Use the real-run command when wall-clock evidence is required:

```powershell
npm run profile:performance -- --real-idle-hours 8
```

That command samples once per minute for eight hours and labels the drift result `real-wall-clock`. A shorter diagnostic run can use `--real-idle-hours 0.1`; only the requested wall-clock duration is claimed.

## Mascot Pressure Policy

The renderer samples JavaScript heap pressure and recent local interaction latency. Under moderate pressure it keeps the Live2D model loaded but disables automatic interaction and reduces the ticker to the idle frame rate. Only three consecutive critical-pressure samples select the static mascot, so animation resources are reduced before static fallback. If memory or latency recovers after static fallback, the model reloads through the normal model lifecycle.
