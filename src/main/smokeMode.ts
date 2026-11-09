import {
    app,
    BrowserWindow,
    type BrowserWindow as BrowserWindowType
} from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
    createProductionSmokeFixture,
    runProductionFullFlow,
    runProductionResourceProfile
} from './smokeProductionFixture';

interface SmokePayload {
    ping: {
        version: string;
    };
    requireIsUndefined: boolean;
    processIsUndefined: boolean;
    mascotRenderMode?: string;
    live2D?: unknown;
    fullFlow?: unknown;
    resourceProfile?: unknown;
}

interface SmokeResult {
    scenario: string;
    payload: SmokePayload;
    windowCount: number;
    url: string;
}

let settled = false;
const smokeCompletionMarker = 'DESKTOP_PET_SMOKE_COMPLETE';

function exitAfterShutdownAck(exitCode: number): void {
    const scratchDir = process.env.DESKTOP_PET_TEST_SCRATCH_DIR;
    if (
        scratchDir === undefined
        || process.env.DESKTOP_PET_SMOKE_SHUTDOWN_ACK !== '1'
    ) {
        app.exit(exitCode);
        return;
    }
    const ackPath = path.join(scratchDir, 'shutdown-ack');
    const interval = setInterval(() => {
        if (!existsSync(ackPath))
            return;
        clearInterval(interval);
        app.exit(exitCode);
    }, 10);
}

function exitWithMarker(result: SmokeResult): void {
    if (settled)
        return;
    settled = true;
    process.stdout.write(`${smokeCompletionMarker}\n${JSON.stringify(result)}\n`, () => {
        exitAfterShutdownAck(0);
    });
}

function exitWithError(error: unknown): void {
    if (settled)
        return;
    settled = true;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stdout.write(`${smokeCompletionMarker}\n`, () => {
        process.stderr.write(`${message}\n`, () => {
            exitAfterShutdownAck(1);
        });
    });
}

async function collectSmokePayload(
    window: BrowserWindowType,
    scenario: string
): Promise<SmokePayload> {
    const preflight = await Promise.race([
        window.webContents.executeJavaScript('({ pingType: typeof window.desktopPet?.ping })'),
        new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('Renderer smoke preflight timed out')), 5_000);
        })
    ]);
    if ((preflight as { pingType?: unknown }).pingType !== 'function')
        throw new Error('Renderer smoke preload API is unavailable');
    const result = await Promise.race([
        window.webContents.executeJavaScript(`(async () => {
            const ping = await window.desktopPet.ping();
            return {
                ping,
                requireIsUndefined: window.require === undefined,
                processIsUndefined: window.process === undefined
            };
        })()`),
        new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('Renderer smoke ping timed out')), 5_000);
        })
    ]);
    const payload = result as SmokePayload;
    const exposures = [
        payload.requireIsUndefined !== true ? 'window.require' : undefined,
        payload.processIsUndefined !== true ? 'window.process' : undefined
    ].filter((exposure): exposure is string => exposure !== undefined);
    if (exposures.length > 0)
        throw new Error(`Renderer smoke assertion failed: ${exposures.join(' and ')} must be undefined`);
    if (scenario === 'live2d-real') {
        const diagnostics = await Promise.race([
            window.webContents.executeJavaScript(`(async () => {
                const deadline = Date.now() + 10000;
                let api;
                while (!(api = window.__desktopPetLive2DSmoke)) {
                    if (Date.now() > deadline) {
                        const stage = document.querySelector('[data-testid="live2d-stage"]');
                        throw new Error('Live2D smoke API timed out: '
                            + (stage?.getAttribute('data-render-error') ?? 'unknown'));
                    }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                for (const state of [
                    'thinking',
                    'success',
                    'error',
                    'quizzing',
                    'happy',
                    'sad'
                ])
                    await api.setState(state);
                api.interact();
                return {
                    mascotRenderMode: document.querySelector(
                        '[data-testid="live2d-stage"]'
                    )?.getAttribute('data-render-mode') ?? 'missing',
                    live2D: api.snapshot()
                };
            })()`),
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new Error('Renderer Live2D smoke timed out')), 12_000);
            })
        ]) as {
            mascotRenderMode: string;
            live2D: unknown;
        };
        payload.mascotRenderMode = diagnostics.mascotRenderMode;
        payload.live2D = diagnostics.live2D;
        return payload;
    }
    if (scenario === 'full-flow')
        return collectProductionFullFlowPayload(window, payload);
    if (scenario === 'resource-profile')
        return collectProductionResourceProfilePayload(window, payload);
    if (scenario !== 'live2d-fallback')
        return payload;
    const mascotRenderMode = await Promise.race([
        window.webContents.executeJavaScript(`new Promise((resolve) => {
            const readStage = () => {
                const stage = document.querySelector('[data-testid="live2d-stage"]');
                resolve(stage?.getAttribute('data-render-mode') ?? 'missing');
            };
            readStage();
            setTimeout(readStage, 250);
        })`),
        new Promise<string>((resolve) => {
            setTimeout(() => resolve('missing'), 2_000);
        })
    ]);
    if (typeof mascotRenderMode !== 'string')
        throw new Error('Renderer smoke mascot render mode is invalid');
    payload.mascotRenderMode = mascotRenderMode;
    if (typeof payload.mascotRenderMode !== 'string')
        throw new Error('Renderer smoke mascot render mode is invalid');
    return payload;
}

async function collectProductionFullFlowPayload(
    window: BrowserWindowType,
    basePayload: SmokePayload
): Promise<SmokePayload> {
    const scratchDir = process.env.DESKTOP_PET_TEST_SCRATCH_DIR;
    if (scratchDir === undefined)
        throw new Error('Production smoke fixture requires a test scratch directory.');
    const fixture = await createProductionSmokeFixture(scratchDir);
    try {
        return {
            ...basePayload,
            fullFlow: await runProductionFullFlow(window, fixture)
        };
    } finally {
        await fixture.dispose();
    }
}

async function collectProductionResourceProfilePayload(
    window: BrowserWindowType,
    basePayload: SmokePayload
): Promise<SmokePayload> {
    const scratchDir = process.env.DESKTOP_PET_TEST_SCRATCH_DIR;
    if (scratchDir === undefined)
        throw new Error('Production smoke fixture requires a test scratch directory.');
    const fixture = await createProductionSmokeFixture(scratchDir);
    try {
        return {
            ...basePayload,
            resourceProfile: await runProductionResourceProfile(window, fixture)
        };
    } finally {
        await fixture.dispose();
    }
}

export function runSmokeModeIfEnabled(window: BrowserWindowType): boolean {
    const scenario = process.env.DESKTOP_PET_SMOKE_SCENARIO;
    if (!scenario)
        return false;

    const run = () => {
        void (async () => {
            const payload = await collectSmokePayload(window, scenario);
            exitWithMarker({
                scenario,
                payload,
                windowCount: BrowserWindow.getAllWindows().length,
                url: window.webContents.getURL()
            });
        })().catch(exitWithError);
    };

    const startWhenLoaded = () => {
        if (window.webContents.getURL() && !window.webContents.isLoading())
            run();
        else
            window.webContents.once('did-finish-load', run);
    };
    startWhenLoaded();
    window.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
        exitWithError(new Error(`Renderer failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`));
    });

    return true;
}
