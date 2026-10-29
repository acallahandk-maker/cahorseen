import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
    };
    windowCount: number;
    url: string;
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
            ...(live2D === undefined ? {} : { live2D })
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

export async function runElectronSmoke(scenario: string): Promise<ElectronSmokeResult> {
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

            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });

            const timeout = setTimeout(() => {
                killElectronProcessTree(child);
                reject(new Error(`Electron smoke timed out for scenario ${scenario}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
            }, 15_000);

            child.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
            child.once('close', (code) => {
                clearTimeout(timeout);
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
                    resolve(parseSmokeResult(markers[0], scenario));
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
    } finally {
        removeUserDataDir(userDataDir);
    }
}
