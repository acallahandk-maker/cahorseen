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
    accelerateIdleDrift,
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

function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
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
        return 126;
    const value = Number(args[index + 1]);
    return Number.isFinite(value) && value > 0 ? value : 126;
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
    temporaryDirectories.push(userDataDir);
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
            DESKTOP_PET_PROFILE_IDLE_MS: String(idleWaitMs)
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
            elapsedMs: Date.now() - startedAt
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
    const idleSamples = samples.filter((sample) => (
        sample.elapsedMs >= Math.min(5_000, idleWaitMs / 4)
        && sample.elapsedMs < idleWaitMs - (realIdleHours > 0 ? 60_000 : 250)
    ));
    const activeSamples = samples.filter((sample) => sample.elapsedMs >= idleWaitMs);
    const normalPrivateBytes = median(idleSamples.map((sample) => sample.privateBytes));
    const peakPrivateBytes = Math.max(
        normalPrivateBytes,
        ...activeSamples.map((sample) => sample.privateBytes)
    );
    const idleCpuPercent = cpuPercent(idleSamples);
    const activeCpuPercent = cpuPercent(activeSamples);
    const measurement = {
        idleCpuPercent,
        activeCpuPercent,
        normalPrivateBytes,
        peakPrivateBytes,
        interactionLatencyMs: Number(resourceProfile.interactionLatencyMs ?? 0)
    };
    const startPrivateBytes = idleSamples[0]?.privateBytes ?? normalPrivateBytes;
    const endPrivateBytes = idleSamples.at(-1)?.privateBytes ?? normalPrivateBytes;
    const wallClockDurationMs = idleSamples.length < 2
        ? 0
        : (idleSamples.at(-1)?.elapsedMs ?? 0) - (idleSamples[0]?.elapsedMs ?? 0);
    const drift = realIdleHours > 0
        ? {
            measurementKind: 'real-wall-clock',
            simulatedHours: realIdleHours,
            wallClockDurationMs,
            wallClockHoursMeasured: wallClockDurationMs / 3_600_000,
            startPrivateBytes,
            endPrivateBytes,
            growthBytes: endPrivateBytes - startPrivateBytes,
            sampleCount: idleSamples.length,
            targetBytes: 25 * 1024 * 1024,
            pass: endPrivateBytes - startPrivateBytes <= 25 * 1024 * 1024
        }
        : accelerateIdleDrift({
            startPrivateBytes,
            samples: idleSamples.map((sample) => sample.privateBytes),
            simulatedHours: 8,
            wallClockDurationMs
        });
    const evaluation = evaluatePerformanceProfile(measurement);
    const report = {
        measurementKind: realIdleHours > 0
            ? 'electron-real-wall-clock-profile'
            : 'electron-profile-with-accelerated-8-hour-equivalent-idle-drift',
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        sampleIntervalMs,
        idleEquivalentHours: 8,
        equivalentSampleSpacingMinutes: realIdleHours > 0
            ? 1
            : 8 * 60 / Math.max(1, idleSamples.length),
        interactionLatencyScope: 'local synthetic provider; excludes network',
        activeWorkload: 'synthetic selection and screenshot translations',
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
