import { app, BrowserWindow, type BrowserWindow as BrowserWindowType } from 'electron';

interface SmokePayload {
    ping: {
        version: string;
    };
    requireIsUndefined: boolean;
    processIsUndefined: boolean;
    mascotRenderMode?: string;
    live2D?: unknown;
}

interface SmokeResult {
    scenario: string;
    payload: SmokePayload;
    windowCount: number;
    url: string;
}

let settled = false;

function exitWithMarker(result: SmokeResult): void {
    if (settled)
        return;
    settled = true;
    process.stdout.write(`${JSON.stringify(result)}\n`, () => {
        app.exit(0);
    });
}

function exitWithError(error: unknown): void {
    if (settled)
        return;
    settled = true;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`, () => {
        app.exit(1);
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
