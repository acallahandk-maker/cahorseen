import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const electronPath = createRequire(import.meta.url)('electron') as string;
type ElectronSmokeProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ElectronSmokeResult {
    scenario: string;
    payload: {
        ping: {
            version: string;
        };
        requireIsUndefined: boolean;
        processIsUndefined: boolean;
    };
    windowCount: number;
    url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
            processIsUndefined: value.payload.processIsUndefined
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

    try {
        return await new Promise<ElectronSmokeResult>((resolve, reject) => {
            const child = spawn(electronPath, [
                '--disable-gpu',
                '--no-sandbox',
                `--user-data-dir=${userDataDir}`,
                projectRoot
            ], {
                cwd: projectRoot,
                env: {
                    ...process.env,
                    DESKTOP_PET_SMOKE_SCENARIO: scenario
                },
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
