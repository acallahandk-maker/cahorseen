import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const electronPath = createRequire(import.meta.url)('electron') as string;
type ElectronSmokeProcess = ChildProcessByStdio<null, Readable, Readable>;
const nodeExposureScenario = 'app-smoke-node-exposure';
const nodeExposureRendererUrl = 'data:text/html,<script>window.require = {}; window.process = {};</script>';

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

function processTreeSnapshot(): Array<{ processId: number; parentProcessId: number }> {
    if (process.platform !== 'win32')
        return [];
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
    });
    if (result.status !== 0 || result.stdout.trim() === '')
        return [];
    try {
        const parsed: unknown = JSON.parse(result.stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.flatMap((row) => {
            if (
                typeof row !== 'object'
                || row === null
                || typeof (row as { ProcessId?: unknown }).ProcessId !== 'number'
                || typeof (row as { ParentProcessId?: unknown }).ParentProcessId !== 'number'
            )
                return [];
            return [{
                processId: (row as { ProcessId: number }).ProcessId,
                parentProcessId: (row as { ParentProcessId: number }).ParentProcessId
            }];
        });
    } catch {
        return [];
    }
}

function descendantProcessIds(rootPid: number): number[] {
    const rows = processTreeSnapshot();
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

function runningProcessIds(): Set<number> {
    return new Set(processTreeSnapshot().map((row) => row.processId));
}

function persistedScreenshotFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
        try {
            const entries = readdirSync(directory, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(directory, entry.name);
                if (entry.isDirectory())
                    walk(entryPath);
                else if (/\.(png|jpe?g|webp)$/i.test(entry.name))
                    files.push(entryPath);
            }
        } catch {
            return;
        }
    };
    walk(root);
    return files.sort();
}

export async function runElectronSmoke(
    scenario: string,
    options: ElectronSmokeOptions = {}
): Promise<ElectronSmokeResult> {
    const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'desktop-pet-electron-smoke-'));
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        DESKTOP_PET_SMOKE_SCENARIO: scenario
    };
    if (scenario === nodeExposureScenario)
        environment.ELECTRON_RENDERER_URL = nodeExposureRendererUrl;
    else
        delete environment.ELECTRON_RENDERER_URL;

    let stdout = '';
    let stderr = '';
    const observedProcessIds = new Set<number>();
    try {
        return await new Promise<ElectronSmokeResult>((resolve, reject) => {
            const rendererArguments = scenario === 'live2d-real'
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
            });
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });
            const processSampler = setInterval(() => {
                if (child.pid !== undefined) {
                    for (const processId of descendantProcessIds(child.pid))
                        observedProcessIds.add(processId);
                }
            }, 250);

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
                    resolve({
                        ...parsed,
                        ...(options.includeDiagnostics === true
                            ? {
                                diagnostics: {
                                    persistedScreenshotFiles: persistedScreenshotFiles(userDataDir),
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
    }
}
