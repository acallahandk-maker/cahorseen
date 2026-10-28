import { app, BrowserWindow, type BrowserWindow as BrowserWindowType } from 'electron';

interface SmokePayload {
    ping: {
        version: string;
    };
    requireIsUndefined: boolean;
    processIsUndefined: boolean;
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

async function collectSmokePayload(window: BrowserWindowType): Promise<SmokePayload> {
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
    return payload;
}

export function runSmokeModeIfEnabled(window: BrowserWindowType): boolean {
    const scenario = process.env.DESKTOP_PET_SMOKE_SCENARIO;
    if (!scenario)
        return false;

    const run = () => {
        void (async () => {
            const payload = await collectSmokePayload(window);
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
