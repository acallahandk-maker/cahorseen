import {
    spawn,
    spawnSync
} from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    evaluateAcceleratedIdleDrift,
    evaluatePerformanceProfile,
    PERFORMANCE_TARGETS
} from '../src/shared/performanceProfile.ts';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const electronPath = createRequire(import.meta.url)('electron');
const temporaryDirectories = [];

function processRows() {
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
    });
    if (result.status !== 0 || result.stdout.trim() === '')
        return [];
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
        processId: Number(row.ProcessId),
        parentProcessId: Number(row.ParentProcessId),
        privateBytes: Number(row.PrivatePageCount),
        cpuMicros: (Number(row.UserModeTime) + Number(row.KernelModeTime)) / 10
    }));
}

function treeSnapshot(rootPid) {
    const rows = processRows();
    const children = new Map();
    for (const row of rows) {
        const siblings = children.get(row.parentProcessId) ?? [];
        siblings.push(row);
        children.set(row.parentProcessId, siblings);
    }
    const selected = [];
    const queue = [rootPid];
    const seen = new Set([rootPid]);
    while (queue.length > 0) {
        const parentId = queue.shift();
        for (const row of children.get(parentId) ?? []) {
            if (seen.has(row.processId))
                continue;
            seen.add(row.processId);
            selected.push(row);
            queue.push(row.processId);
        }
    }
    const root = rows.find((row) => row.processId === rootPid);
    if (root !== undefined)
        selected.push(root);
    return {
        privateBytes: selected.reduce((sum, row) => sum + row.privateBytes, 0),
        cpuMicros: selected.reduce((sum, row) => sum + row.cpuMicros, 0),
        cpuMicrosByProcessId: Object.fromEntries(
            selected.map((row) => [row.processId, row.cpuMicros])
        ),
        processIds: selected.map((row) => row.processId)
    };
}

function cpuPercent(samples) {
    if (samples.length < 2)
        return 0;
    let cpuMicros = 0;
    let elapsedMs = 0;
    for (let index = 1; index < samples.length; index += 1) {
        const previous = samples[index - 1].cpuMicrosByProcessId;
        for (const [processId, currentCpuMicros] of Object.entries(
            samples[index].cpuMicrosByProcessId
        )) {
            cpuMicros += Math.max(0, currentCpuMicros - (previous[processId] ?? 0));
        }
        elapsedMs += samples[index].elapsedMs - samples[index - 1].elapsedMs;
    }
    return elapsedMs <= 0 ? 0 : cpuMicros / 1000 / elapsedMs * 100;
}

function parseRealIdleHours(args) {
    const index = args.indexOf('--real-idle-hours');
    if (index === -1)
        return 0;
    const value = Number(args[index + 1]);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseAcceleratedSeconds(args) {
    const index = args.indexOf('--accelerated-seconds');
    if (index === -1)
        return 12;
    const value = Number(args[index + 1]);
    return Number.isFinite(value) && value > 0 ? value : 12;
}

function parseMarker(stdout) {
    const marker = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{') && line.endsWith('}'))
        .at(-1);
    return marker === undefined ? {} : JSON.parse(marker);
}

async function runProfile() {
    if (process.platform !== 'win32')
        throw new Error('The Windows resource profile requires Windows process metrics.');
    const profileArguments = process.argv.slice(2);
    const realIdleHours = parseRealIdleHours(profileArguments);
    const acceleratedSeconds = parseAcceleratedSeconds(profileArguments);
    const idleWaitMs = realIdleHours > 0
        ? Math.round(realIdleHours * 60 * 60 * 1000)
        : Math.round(acceleratedSeconds * 1_000);
    const sampleIntervalMs = realIdleHours > 0 ? 60_000 : 250;
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'desktop-pet-performance-'));
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'desktop-pet-performance-scratch-'));
    temporaryDirectories.push(userDataDir);
    temporaryDirectories.push(scratchDir);
    const child = spawn(electronPath, [
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${userDataDir}`,
        projectRoot
    ], {
        cwd: projectRoot,
        env: {
            ...process.env,
            DESKTOP_PET_SMOKE_SCENARIO: 'resource-profile',
            DESKTOP_PET_PROFILE_IDLE_MS: String(idleWaitMs),
            DESKTOP_PET_TEST_SCRATCH_DIR: scratchDir
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });
    const startedAt = Date.now();
    const samples = [];
    const sampler = setInterval(() => {
        if (child.pid === undefined)
            return;
        const snapshot = treeSnapshot(child.pid);
        samples.push({
            ...snapshot,
            elapsedMs: Date.now() - startedAt,
            observedAtMs: Date.now()
        });
    }, sampleIntervalMs);
    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    clearInterval(sampler);
    if (exitCode !== 0)
        throw new Error(`Performance harness exited with code ${String(exitCode)}\n${stderr}`);
    const marker = parseMarker(stdout);
    const resourceProfile = marker.payload?.resourceProfile ?? {};
    const idleStartedAtMs = Number(resourceProfile.idleStartedAtMs ?? 0);
    const idleEndedAtMs = Number(resourceProfile.idleEndedAtMs ?? 0);
    const idleSamples = samples.filter((sample) => (
        sample.observedAtMs >= idleStartedAtMs
        && sample.observedAtMs <= idleEndedAtMs
    ));
    const stableIdleSamples = idleSamples.filter((sample) => (
        sample.observedAtMs >= idleStartedAtMs + 2_000
        && sample.observedAtMs <= idleEndedAtMs - 2_000
    ));
    if (stableIdleSamples.length < 2)
        throw new Error('Performance harness did not collect a distinct idle interval');
    const idleCpuPercent = cpuPercent(stableIdleSamples);
    const measurement = {
        idleCpuPercent,
        activeCpuPercent: Number(resourceProfile.activeCpuPercent ?? 0),
        normalPrivateBytes: Number(resourceProfile.normalPrivateBytes ?? 0),
        peakPrivateBytes: Number(resourceProfile.peakPrivateBytes ?? 0),
        interactionLatencyMs: Number(resourceProfile.interactionLatencyMs ?? 0)
    };
    const drift = realIdleHours > 0
        ? {
            measurementKind: 'real-wall-clock',
            measuredHours: realIdleHours,
            wallClockDurationMs: Math.max(0, idleEndedAtMs - idleStartedAtMs),
            startPrivateBytes: idleSamples[0]?.privateBytes ?? 0,
            endPrivateBytes: idleSamples.at(-1)?.privateBytes ?? 0,
            growthBytes: (idleSamples.at(-1)?.privateBytes ?? 0) - (idleSamples[0]?.privateBytes ?? 0),
            sampleCount: idleSamples.length,
            targetBytes: 25 * 1024 * 1024,
            pass: (idleSamples.at(-1)?.privateBytes ?? 0) - (idleSamples[0]?.privateBytes ?? 0)
                <= 25 * 1024 * 1024
        }
        : evaluateAcceleratedIdleDrift({
            startPrivateBytes: Number(resourceProfile.driftStartPrivateBytes ?? 0),
            samples: resourceProfile.driftSamples,
            cycleModel: {
                kind: 'idle-equivalent-local-maintenance',
                virtualHours: 8,
                minutesPerCycle: 1,
                cycleCount: 480
            },
            wallClockDurationMs: Number(resourceProfile.driftWallClockDurationMs ?? 0)
        });
    const evaluation = evaluatePerformanceProfile(measurement);
    const report = {
        measurementKind: realIdleHours > 0
            ? 'electron-real-wall-clock-profile'
            : 'electron-profile-with-accelerated-workload-cycles',
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        sampleIntervalMs,
        idleEquivalentHours: 8,
        equivalentSampleSpacingMinutes: 1,
        interactionLatencyScope: 'local synthetic provider; excludes network',
        activeWorkload: 'production selection and screenshot services with local provider HTTP',
        activeCpuBasis: 'electron-app-metrics-active-work-window',
        screenshotPeakBasis: 'electron-app-metrics-private-bytes-fine-sampled',
        interactionLatencyBasis: String(
            resourceProfile.interactionLatencyBasis ?? ''
        ),
        activeWindowMs: Number(resourceProfile.activeWindowMs ?? 0),
        screenshotCaptureCount: Number(resourceProfile.screenshotCaptureCount ?? 0),
        screenshotPeakPrivateBytes: Number(
            resourceProfile.screenshotPeakPrivateBytes ?? 0
        ),
        idleDriftBasis: realIdleHours > 0
            ? 'electron-app-metrics-private-bytes-real-wall-clock'
            : 'electron-app-metrics-private-bytes-executed-workload-cycles',
        realRunCommand: 'npm run profile:performance -- --real-idle-hours 8',
        targets: PERFORMANCE_TARGETS,
        measurement,
        idleDrift: drift,
        interactionSamples: Number(resourceProfile.interactionSamples ?? 0),
        evaluation
    };
    mkdirSync(path.join(projectRoot, 'out'), { recursive: true });
    writeFileSync(
        path.join(projectRoot, 'out', 'performance-profile.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8'
    );
    console.log(JSON.stringify(report, null, 2));
    if (!evaluation.pass || !drift.pass)
        process.exitCode = 1;
}

runProfile().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}).finally(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, {
            force: true,
            recursive: true
        });
    }
});
