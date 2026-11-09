import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import {
    closeSync,
    mkdtempSync,
    openSync,
    readSync,
    readdirSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const electronPath = createRequire(import.meta.url)('electron') as string;
type ElectronSmokeProcess = ChildProcessByStdio<null, Readable, Readable>;
const nodeExposureScenario = 'app-smoke-node-exposure';
const nodeExposureRendererUrl = 'data:text/html,<script>window.require = {}; window.process = {};</script>';
const smokeCompletionMarker = 'DESKTOP_PET_SMOKE_COMPLETE';

export interface Live2DSmokeDiagnostic {
    licenseNoticePresent: boolean;
    model: {
        autoInteract: boolean;
        parameterCount: number;
        textureCount: number;
        motionGroupCount: number;
        hitAreas: string[];
    };
    canvas: {
        nonTransparentPixels: number;
        distinctColors: number;
    };
    interaction: {
        hitAreas: string[];
        tapCount: number;
    };
    stateMappings: Array<{
        state: string;
        action: string;
        parameters: Record<string, number>;
        motionStarted: boolean;
    }>;
}

export interface ElectronSmokeResult {
    scenario: string;
    payload: {
        ping: {
            version: string;
        };
        requireIsUndefined: boolean;
        processIsUndefined: boolean;
        mascotRenderMode?: string;
        live2D?: Live2DSmokeDiagnostic;
        fullFlow?: unknown;
    };
    windowCount: number;
    url: string;
    diagnostics?: ElectronSmokeDiagnostics;
}

export interface ElectronSmokeDiagnostics {
    persistedScreenshotFiles: string[];
    leakedProcessIds: number[];
    stdout: string;
    stderr: string;
}

export interface ElectronSmokeOptions {
    includeDiagnostics?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        throw new Error('Electron Live2D smoke string array is invalid');
    return [...value] as string[];
}

function numberRecord(value: unknown): Record<string, number> {
    if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'number'))
        throw new Error('Electron Live2D smoke parameter record is invalid');
    return { ...value } as Record<string, number>;
}

function parseLive2DSmoke(value: unknown): Live2DSmokeDiagnostic {
    if (
        !isRecord(value)
        || typeof value.licenseNoticePresent !== 'boolean'
        || !isRecord(value.model)
        || !isRecord(value.canvas)
    )
        throw new Error('Electron Live2D smoke diagnostic is invalid');
    if (!isRecord(value.interaction) || !Array.isArray(value.stateMappings))
        throw new Error('Electron Live2D smoke diagnostic is incomplete');
    if (
        typeof value.model.autoInteract !== 'boolean'
        || typeof value.model.parameterCount !== 'number'
        || typeof value.model.textureCount !== 'number'
        || typeof value.model.motionGroupCount !== 'number'
        || typeof value.canvas.nonTransparentPixels !== 'number'
        || typeof value.canvas.distinctColors !== 'number'
        || typeof value.interaction.tapCount !== 'number'
        || typeof value.interaction.hitAreas === 'undefined'
        || typeof value.model.hitAreas === 'undefined'
    )
        throw new Error('Electron Live2D smoke diagnostic values are invalid');

    const stateMappings = value.stateMappings.map((mapping) => {
        if (
            !isRecord(mapping)
            || typeof mapping.state !== 'string'
            || typeof mapping.action !== 'string'
            || typeof mapping.motionStarted !== 'boolean'
        )
            throw new Error('Electron Live2D smoke state mapping is invalid');
        return {
            state: mapping.state,
            action: mapping.action,
            parameters: numberRecord(mapping.parameters),
            motionStarted: mapping.motionStarted
        };
    });
    return {
        licenseNoticePresent: value.licenseNoticePresent,
        model: {
            autoInteract: value.model.autoInteract,
            parameterCount: value.model.parameterCount,
            textureCount: value.model.textureCount,
            motionGroupCount: value.model.motionGroupCount,
            hitAreas: stringArray(value.model.hitAreas)
        },
        canvas: {
            nonTransparentPixels: value.canvas.nonTransparentPixels,
            distinctColors: value.canvas.distinctColors
        },
        interaction: {
            hitAreas: stringArray(value.interaction.hitAreas),
            tapCount: value.interaction.tapCount
        },
        stateMappings
    };
}

function parseSmokeResult(marker: string, expectedScenario: string): ElectronSmokeResult {
    const value: unknown = JSON.parse(marker);
    if (!isRecord(value))
        throw new Error('Electron smoke marker is not a JSON object');
    if (value.scenario !== expectedScenario)
        throw new Error(`Electron smoke marker scenario was ${JSON.stringify(value.scenario)}`);
    if (!isRecord(value.payload))
        throw new Error('Electron smoke marker payload is not a JSON object');
    if (!isRecord(value.payload.ping) || typeof value.payload.ping.version !== 'string')
        throw new Error('Electron smoke marker ping result is invalid');
    if (typeof value.payload.requireIsUndefined !== 'boolean')
        throw new Error('Electron smoke marker require result is invalid');
    if (typeof value.payload.processIsUndefined !== 'boolean')
        throw new Error('Electron smoke marker process result is invalid');
    if (
        value.payload.mascotRenderMode !== undefined
        && typeof value.payload.mascotRenderMode !== 'string'
    )
        throw new Error('Electron smoke marker mascot render mode is invalid');
    const live2D = value.payload.live2D === undefined
        ? undefined
        : parseLive2DSmoke(value.payload.live2D);
    if (typeof value.windowCount !== 'number')
        throw new Error('Electron smoke marker windowCount is invalid');
    if (typeof value.url !== 'string')
        throw new Error('Electron smoke marker url is invalid');

    return {
        scenario: expectedScenario,
        payload: {
            ping: {
                version: value.payload.ping.version
            },
            requireIsUndefined: value.payload.requireIsUndefined,
            processIsUndefined: value.payload.processIsUndefined,
            ...(typeof value.payload.mascotRenderMode === 'string'
                ? { mascotRenderMode: value.payload.mascotRenderMode }
                : {}),
            ...(live2D === undefined ? {} : { live2D }),
            ...(value.payload.fullFlow === undefined
                ? {}
                : { fullFlow: value.payload.fullFlow })
        },
        windowCount: value.windowCount,
        url: value.url
    };
}

function removeUserDataDir(userDataDir: string): void {
    try {
        rmSync(userDataDir, { force: true, recursive: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM')
            throw error;
    }
}

function killElectronProcessTree(child: ElectronSmokeProcess): void {
    if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
        });
        return;
    }
    child.kill();
}

export interface ProcessSnapshotResult {
    status: number | null;
    stdout: string;
}

export function parseProcessRows(
    result: ProcessSnapshotResult,
    rootPid: number
): Array<{ processId: number; parentProcessId: number }> {
    if (!Number.isInteger(rootPid) || rootPid <= 0)
        throw new Error('process snapshot root process is required');
    if (
        result.status !== 0
        || result.stdout.trim() === ''
    )
        throw new Error('process snapshot failed');
    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        throw new Error('process snapshot failed');
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.length === 0)
        throw new Error('process snapshot failed');
    const processRows = rows.map((row) => {
        if (
            typeof row !== 'object'
            || row === null
            || typeof (row as { ProcessId?: unknown }).ProcessId !== 'number'
            || typeof (row as { ParentProcessId?: unknown }).ParentProcessId !== 'number'
        )
            throw new Error('process snapshot failed');
        return {
            processId: (row as { ProcessId: number }).ProcessId,
            parentProcessId: (row as { ParentProcessId: number }).ParentProcessId
        };
    });
    if (!processRows.some((row) => row.processId === rootPid))
        throw new Error('process snapshot root process is missing');
    return processRows;
}

function processTreeSnapshot(
    rootPid: number
): Array<{ processId: number; parentProcessId: number }> {
    if (process.platform !== 'win32')
        throw new Error('process snapshot failed');
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
    });
    return parseProcessRows(result, rootPid);
}

export function descendantProcessIdsFromRows(
    rows: readonly { processId: number; parentProcessId: number }[],
    rootPid: number
): number[] {
    if (
        !Number.isInteger(rootPid)
        || rootPid <= 0
        || !rows.some((row) => row.processId === rootPid)
    )
        throw new Error('process snapshot root process is missing');
    const children = new Map<number, number[]>();
    for (const row of rows) {
        const siblings = children.get(row.parentProcessId) ?? [];
        siblings.push(row.processId);
        children.set(row.parentProcessId, siblings);
    }
    const descendants: number[] = [];
    const queue = [rootPid];
    const seen = new Set<number>([rootPid]);
    while (queue.length > 0) {
        const parentId = queue.shift();
        if (parentId === undefined)
            continue;
        for (const childId of children.get(parentId) ?? []) {
            if (seen.has(childId))
                continue;
            seen.add(childId);
            descendants.push(childId);
            queue.push(childId);
        }
    }
    return descendants;
}

function descendantProcessIds(rootPid: number): number[] {
    return descendantProcessIdsFromRows(processTreeSnapshot(rootPid), rootPid);
}

function runningProcessIds(): Set<number> {
    return new Set(processTreeSnapshot(process.pid).map((row) => row.processId));
}

function isScreenshotSignature(filePath: string): boolean {
    const header = Buffer.alloc(16);
    let descriptor: number | undefined;
    try {
        descriptor = openSync(filePath, 'r');
        readSync(descriptor, header, 0, header.length, 0);
    } catch {
        throw new Error('screenshot persistence scan failed');
    } finally {
        if (typeof descriptor === 'number')
            closeSync(descriptor);
    }
    return header.subarray(0, 8).equals(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]))
        || header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        || (header.subarray(0, 4).toString('ascii') === 'RIFF'
            && header.subarray(8, 12).toString('ascii') === 'WEBP')
        || header.subarray(0, 4).toString('ascii') === 'GIF8'
        || header.subarray(0, 2).toString('ascii') === 'BM'
        || header.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
        || header.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
        || (header.subarray(4, 8).toString('ascii') === 'ftyp'
            && header.subarray(8, 12).toString('ascii').startsWith('avi'));
}

export function findPersistedScreenshotFiles(roots: readonly string[]): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            throw new Error(`screenshot persistence scan failed: ${directory}`);
        }
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules')
                    continue;
                walk(entryPath);
            } else if (entry.isFile() && isScreenshotSignature(entryPath)) {
                files.push(entryPath);
            }
        }
    };
    for (const root of roots) {
        try {
            walk(root);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith(
                'screenshot persistence scan failed'
            ))
                throw error;
            throw new Error(
                `screenshot persistence scan failed: ${root}`,
                { cause: error }
            );
        }
    }
    return files.sort();
}

export async function runElectronSmoke(
    scenario: string,
    options: ElectronSmokeOptions = {}
): Promise<ElectronSmokeResult> {
    const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'desktop-pet-electron-smoke-'));
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'desktop-pet-electron-scratch-'));
    const shutdownAckPath = path.join(scratchDir, 'shutdown-ack');
    const workspaceImagesBefore = new Set(findPersistedScreenshotFiles([projectRoot]));
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        DESKTOP_PET_SMOKE_SCENARIO: scenario,
        DESKTOP_PET_SMOKE_SHUTDOWN_ACK: '1',
        DESKTOP_PET_TEST_SCRATCH_DIR: scratchDir
    };
    if (scenario === nodeExposureScenario)
        environment.ELECTRON_RENDERER_URL = nodeExposureRendererUrl;
    else
        delete environment.ELECTRON_RENDERER_URL;

    let stdout = '';
    let stderr = '';
    let shutdownObserved = false;
    const observedProcessIds = new Set<number>();
    try {
        return await new Promise<ElectronSmokeResult>((resolve, reject) => {
            const rendererArguments = [
                'full-flow',
                'live2d-real'
            ].includes(scenario)
                ? [
                    '--use-gl=angle',
                    '--use-angle=swiftshader',
                    '--enable-unsafe-swiftshader'
                ]
                : ['--disable-gpu'];
            const child = spawn(electronPath, [
                '--no-sandbox',
                ...rendererArguments,
                `--user-data-dir=${userDataDir}`,
                projectRoot
            ], {
                cwd: projectRoot,
                env: environment,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            }) as ElectronSmokeProcess;

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
                if (stdout.includes(smokeCompletionMarker)) {
                    shutdownObserved = true;
                    writeFileSync(shutdownAckPath, '');
                }
            });
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });
            const failProcessSnapshot = (error: unknown): void => {
                clearTimeout(timeout);
                clearInterval(processSampler);
                killElectronProcessTree(child);
                reject(error instanceof Error ? error : new Error(String(error)));
            };
            const processSampler = setInterval(() => {
                if (shutdownObserved || child.exitCode !== null)
                    return;
                try {
                    if (child.pid !== undefined) {
                        for (const processId of descendantProcessIds(child.pid))
                            observedProcessIds.add(processId);
                    }
                } catch (error) {
                    failProcessSnapshot(error);
                }
            }, 250);
            child.once('exit', () => {
                shutdownObserved = true;
                clearInterval(processSampler);
            });

            const timeout = setTimeout(() => {
                clearInterval(processSampler);
                killElectronProcessTree(child);
                reject(new Error(`Electron smoke timed out for scenario ${scenario}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
            }, 15_000);

            child.once('error', (error) => {
                clearTimeout(timeout);
                clearInterval(processSampler);
                reject(error);
            });
            child.once('close', (code) => {
                clearTimeout(timeout);
                clearInterval(processSampler);
                if (code !== 0) {
                    reject(new Error(`Electron smoke exited with code ${String(code)}\n${stderr}`));
                    return;
                }

                const markers = stdout
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('{') && line.endsWith('}'));
                if (markers.length !== 1) {
                    reject(new Error(`Expected one JSON marker, found ${markers.length}\n${stdout}\n${stderr}`));
                    return;
                }

                try {
                    const parsed = parseSmokeResult(markers[0], scenario);
                    const running = runningProcessIds();
                    const leakedProcessIds = [...observedProcessIds]
                        .filter((processId) => running.has(processId))
                        .sort((left, right) => left - right);
                    const workspaceImagesAfter = findPersistedScreenshotFiles(
                        [projectRoot]
                    );
                    const persistedScreenshotFiles = [
                        ...workspaceImagesAfter.filter(
                            (filePath) => !workspaceImagesBefore.has(filePath)
                        ),
                        ...findPersistedScreenshotFiles([userDataDir, scratchDir])
                    ];
                    resolve({
                        ...parsed,
                        ...(options.includeDiagnostics === true
                            ? {
                                diagnostics: {
                                    persistedScreenshotFiles: [
                                        ...new Set(persistedScreenshotFiles)
                                    ].sort(),
                                    leakedProcessIds,
                                    stdout,
                                    stderr
                                }
                            }
                            : {})
                    });
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
    } finally {
        removeUserDataDir(userDataDir);
        removeUserDataDir(scratchDir);
    }
}
