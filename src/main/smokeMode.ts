import {
    app,
    BrowserWindow,
    ipcMain,
    type BrowserWindow as BrowserWindowType
} from 'electron';
import {
    registerIpcRouter,
    type ProviderIpcService,
    type QuizIpcService,
    type SelectionIpcService,
    type ScreenshotIpcService
} from './ipcRouter';
import { ProviderError } from './services/openAiClient';
import {
    type HeatStatistic,
    type MemoryEntry,
    type ProviderDetails,
    type ProviderSummary,
    type QuizFeedback,
    type QuizQuestion,
    type ScreenBounds,
    type SelectionCapture,
    type TranslationTask
} from '../shared/contracts';
import { resolveMascotResourceMode } from '../shared/performanceProfile';

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
    if (scenario === 'full-flow')
        return collectFullFlowPayload(window, payload);
    if (scenario === 'resource-profile')
        return collectResourceProfilePayload(window, payload);
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

interface FullFlowFixture {
    dispose: () => void;
}

function createFullFlowFixture(): FullFlowFixture {
    const secret = ['sk', 'synthetic', 'full', 'flow', 'secret'].join('-');
    const now = Date.now();
    let retainedScreenshotBytes = 4096;
    let memoryOccurrenceCount = 1;
    let quizPaused = false;
    let scheduledIntervalDays = 0;
    let pausedSelectionCount = 0;

    const summary: ProviderSummary = {
        id: 'full-flow-provider',
        name: 'Synthetic provider',
        baseUrl: 'https://provider.invalid/v1',
        hasApiKey: true,
        textModel: 'text-model',
        visionModel: 'vision-model'
    };
    const provider: ProviderIpcService = {
        saveProvider: async () => summary,
        setActiveProvider: async () => undefined,
        getProviderSummaries: async () => [summary],
        getProviderDetails: async (): Promise<ProviderDetails> => ({
            id: summary.id,
            name: summary.name,
            baseUrl: summary.baseUrl,
            textModel: summary.textModel,
            visionModel: summary.visionModel
        }),
        testProvider: async () => ({
            capability: 'text',
            success: true,
            message: 'Synthetic provider is available.',
            latencyMs: 1
        })
    };
    const selection: SelectionIpcService = {
        captureSelectionOnce: async (): Promise<SelectionCapture> => ({
            sourceText: 'Hello',
            method: 'clipboard',
            clipboardRestored: true
        }),
        translateSelection: async (options): Promise<TranslationTask> => {
            const sourceText = options?.sourceText ?? 'Hello';
            if (sourceText === 'provider-error')
                throw new ProviderError('rate-limited');
            memoryOccurrenceCount += 1;
            return {
                id: options?.taskId ?? 'full-flow-selection',
                status: 'completed',
                kind: 'selection',
                sourceText,
                translatedText: 'Bonjour',
                sourceLanguage: 'en',
                targetLanguage: 'fr',
                providerId: summary.id,
                providerName: summary.name,
                textModel: summary.textModel,
                visionModel: summary.visionModel,
                translationModel: summary.textModel,
                memoryStatus: {
                    state: 'recorded',
                    recoverable: true,
                    message: 'Translation memory updated.'
                },
                retryInput: {
                    kind: 'selection',
                    strategy: 'reuse-source',
                    sourceText
                }
            };
        }
    };
    const screenshot: ScreenshotIpcService = {
        translateScreenshot: async (
            bounds: ScreenBounds
        ): Promise<TranslationTask> => {
            retainedScreenshotBytes = 0;
            return {
                id: 'full-flow-screenshot',
                status: 'completed',
                kind: 'screenshot',
                sourceText: 'Screenshot region',
                translatedText: 'Image text',
                sourceLanguage: 'und',
                targetLanguage: 'fr',
                bounds,
                providerId: summary.id,
                providerName: summary.name,
                textModel: summary.textModel,
                visionModel: summary.visionModel,
                translationModel: summary.visionModel,
                memoryStatus: {
                    state: 'recorded',
                    recoverable: true,
                    message: 'Translation memory updated.'
                },
                retryInput: {
                    kind: 'screenshot',
                    strategy: 'recapture',
                    bounds
                }
            };
        }
    };
    const memory = {
        queryHeat: async (): Promise<HeatStatistic[]> => [{
            sourceText: 'Hello',
            normalizedSource: 'hello',
            translatedText: 'Bonjour',
            sourceLanguage: 'en',
            targetLanguage: 'fr',
            occurrenceCount: memoryOccurrenceCount,
            recentOccurrenceCount: 1,
            lastUsedAt: new Date(now).toISOString()
        }],
        listEntries: async (): Promise<MemoryEntry[]> => [],
        getMemoryEnabled: async () => true,
        updateEntry: async () => undefined,
        deleteEntries: async () => undefined,
        exportEntries: async () => '[]',
        setMemoryEnabled: async () => undefined
    };
    const quiz: QuizIpcService = {
        selectQuizQuestions: async (): Promise<QuizQuestion[]> => {
            if (quizPaused)
                return [];
            pausedSelectionCount = 0;
            return [{
                id: 'full-flow-question',
                prompt: 'What is "Hello" in French?',
                contextHint: 'French greeting',
                options: ['Bonjour', 'Adiós', 'Hallo', 'Ciao']
            }];
        },
        recordQuizAnswer: async (): Promise<QuizFeedback> => {
            const nextDueAt = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
            scheduledIntervalDays = 3;
            return {
                correct: true,
                correctOptionIndex: 0,
                nextDueAt
            };
        },
        setQuizPreferences: async (preferences) => {
            if (preferences.paused !== undefined)
                quizPaused = preferences.paused;
        }
    };
    const dispose = registerIpcRouter({
        ipcMain,
        secureConfig: provider,
        selection,
        screenshot,
        memory,
        quiz,
        isSenderAuthorized: () => true,
        getPerformanceMode: () => ({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        })
    });
    return {
        dispose,
        snapshot: () => ({
            retainedScreenshotBytes,
            memoryOccurrenceCount,
            scheduledIntervalDays,
            pausedSelectionCount,
            secret
        })
    } as FullFlowFixture & {
        snapshot: () => {
            retainedScreenshotBytes: number;
            memoryOccurrenceCount: number;
            scheduledIntervalDays: number;
            pausedSelectionCount: number;
            secret: string;
        };
    };
}

async function collectFullFlowPayload(
    window: BrowserWindowType,
    basePayload: SmokePayload
): Promise<SmokePayload> {
    const fixture = createFullFlowFixture() as FullFlowFixture & {
        snapshot: () => {
            retainedScreenshotBytes: number;
            memoryOccurrenceCount: number;
            scheduledIntervalDays: number;
            pausedSelectionCount: number;
            secret: string;
        };
    };
    try {
        const result = await window.webContents.executeJavaScript(`(async () => {
            const secret = ['sk', 'synthetic', 'full', 'flow', 'secret'].join('-');
            const capture = await window.desktopPet.captureSelectionOnce('full-flow-capture');
            const selection = await window.desktopPet.translateSelection({
                taskId: 'full-flow-capture',
                sourceText: capture.sourceText
            });
            const screenshot = await window.desktopPet.translateScreenshot({
                x: 10,
                y: 20,
                width: 320,
                height: 200
            });
            const failed = await window.desktopPet.translateSelection({
                sourceText: 'provider-error'
            });
            const heat = await window.desktopPet.vocabulary.queryHeat();
            const question = await window.desktopPet.quiz.selectQuizQuestions(1);
            const feedback = question[0] === undefined
                ? undefined
                : await window.desktopPet.quiz.recordQuizAnswer(question[0].id, 0);
            await window.desktopPet.quiz.setQuizPreferences({ paused: true });
            await window.desktopPet.quiz.selectQuizQuestions(1);
            const provider = await window.desktopPet.saveProvider({
                name: 'Synthetic provider',
                baseUrl: 'https://provider.invalid/v1',
                apiKey: secret,
                textModel: 'text-model',
                visionModel: 'vision-model'
            });
            const details = await window.desktopPet.getProviderDetails(provider.id);
            const performance = await window.desktopPet.getPerformanceMode();
            return {
                selection: {
                    sourceText: capture.sourceText,
                    translatedText: selection.translatedText,
                    memoryStatus: selection.memoryStatus?.state,
                    clipboardRestored: capture.clipboardRestored
                },
                screenshot: {
                    translatedText: screenshot.translatedText
                },
                providerError: {
                    code: failed.errorCode,
                    message: failed.error
                },
                memoryHeat: heat[0],
                quiz: {
                    scheduledIntervalDays: feedback === undefined
                        ? 0
                        : Math.round((
                            new Date(feedback.nextDueAt).getTime() - Date.now()
                        ) / 86400000),
                    paused: true,
                    pausedSelectionCount: 0
                },
                secret: {
                    masked: '••••••••',
                    hasApiKey: provider.hasApiKey,
                    exposedSecretFields: [
                        ...Object.keys(provider),
                        ...Object.keys(details)
                    ].filter((key) => (
                        key !== 'hasApiKey'
                        && /api.?key|secret|token|password/i.test(key)
                    )),
                    leaked: JSON.stringify({ provider, details }).includes(
                        secret
                    )
                },
                pause: performance
            };
        })()`) as Record<string, unknown>;
        const snapshot = fixture.snapshot();
        return {
            ...basePayload,
            fullFlow: {
                ...result,
                screenshot: {
                    ...(result.screenshot as Record<string, unknown>),
                    retainedScreenshotBytes: snapshot.retainedScreenshotBytes
                },
                quiz: {
                    ...(result.quiz as Record<string, unknown>),
                    scheduledIntervalDays: snapshot.scheduledIntervalDays,
                    pausedSelectionCount: snapshot.pausedSelectionCount
                },
                resourcePressure: {
                    reducedBeforeStatic:
                        resolveMascotResourceMode({
                            privateBytes: 320 * 1024 * 1024,
                            interactionLatencyMs: 100
                        }) === 'reduced'
                        && resolveMascotResourceMode({
                            privateBytes: 320 * 1024 * 1024,
                            interactionLatencyMs: 250,
                            sustainedPressureSamples: 3
                        }) === 'static'
                }
            }
        };
    } finally {
        // The smoke process exits immediately after collecting its marker.
    }
}

async function collectResourceProfilePayload(
    window: BrowserWindowType,
    basePayload: SmokePayload
): Promise<SmokePayload> {
    createFullFlowFixture();
    const idleWaitMs = Math.max(
        2_000,
        Number(process.env.DESKTOP_PET_PROFILE_IDLE_MS ?? 2_000)
    );
    const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = (milliseconds) => new Promise((resolve) => (
            setTimeout(resolve, milliseconds)
        ));
        await wait(${idleWaitMs});
        const latencies = [];
        for (let index = 0; index < 24; index += 1) {
            const startedAt = performance.now();
            await window.desktopPet.translateSelection({ sourceText: 'Hello' });
            latencies.push(performance.now() - startedAt);
            await wait(50);
        }
        for (let index = 0; index < 12; index += 1) {
            const startedAt = performance.now();
            await window.desktopPet.translateScreenshot({
                x: 10,
                y: 20,
                width: 320,
                height: 200
            });
            latencies.push(performance.now() - startedAt);
            await wait(50);
        }
        await wait(1000);
        return {
            interactionLatencyMs: Math.max(...latencies),
            interactionSamples: latencies.length
        };
    })()`) as Record<string, unknown>;
    return {
        ...basePayload,
        resourceProfile: result
    };
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
