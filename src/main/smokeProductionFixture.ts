import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { app, ipcMain, type BrowserWindow } from 'electron';
import {
    type ProviderConfig,
    type ProviderSummary,
    type TranslationTask
} from '../shared/contracts';
import { MemoryDatabase } from './services/memoryDatabase';
import { OpenAiClient } from './services/openAiClient';
import { QuizScheduler } from './services/quizScheduler';
import {
    SecureConfigService,
    type SafeStorageLike
} from './services/secureConfig';
import { SelectionService } from './services/selectionService';
import { ScreenshotService } from './services/screenshotService';
import {
    getElectronPrivateBytes,
    getElectronResourcePressureMetrics
} from './services/resourceMetrics';
import {
    SystemIntegration,
    type PowerMonitorLike,
    type ShortcutRegistrar,
    type TrayLike
} from './systemIntegration';
import { registerIpcRouter } from './ipcRouter';
import type {
    ImageTranslationRunner,
    ImageTranslationRunnerRequest,
    TranslationRunner,
    TranslationRunnerRequest
} from './workers/translationWorker';

const secret = ['sk', 'synthetic', 'full', 'flow', 'secret'].join('-');
const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function completedTask(
    id: string,
    sourceText: string,
    translatedText: string
): TranslationTask {
    return {
        id,
        status: 'completed',
        kind: 'selection',
        sourceText,
        translatedText,
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        providerName: 'Local smoke provider',
        textModel: 'text-model',
        visionModel: 'vision-model',
        translationModel: 'text-model',
        retryInput: {
            kind: 'selection',
            strategy: 'reuse-source',
            sourceText
        }
    };
}

async function createProviderServer(): Promise<{
    fetchImpl: typeof fetch;
    close(): Promise<void>;
}> {
    const server: Server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
            body += chunk;
        });
        request.on('end', () => {
            let payload: {
                model?: string;
                messages?: Array<{ content?: unknown }>;
            };
            try {
                payload = JSON.parse(body);
            } catch {
                response.writeHead(400).end();
                return;
            }
            const content = payload.messages?.at(-1)?.content;
            const text = typeof content === 'string'
                ? content
                : JSON.stringify(content);
            if (text.includes('provider-error')) {
                response.writeHead(429, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'rate limited' } }));
                return;
            }
            const value = payload.model === 'vision-model'
                ? JSON.stringify({
                    sourceText: 'Image text',
                    translatedText: 'Image text'
                })
                : 'Bonjour';
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write(`data: ${JSON.stringify({
                choices: [{ delta: { content: value } }]
            })}\n\n`);
            response.write('data: [DONE]\n\n');
            response.end();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
        throw new Error('Local smoke provider did not bind a TCP port.');
    const port = address.port;
    const fetchImpl: typeof fetch = async (input, init) => {
        const source = new URL(String(input));
        return fetch(`http://127.0.0.1:${port}${source.pathname}`, init);
    };
    return {
        fetchImpl,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error));
        })
    };
}

function createSafeStorage(): SafeStorageLike {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8')
    };
}

function createPowerMonitor(): PowerMonitorLike {
    return {
        isOnBatteryPower: () => false,
        getSystemIdleState: () => 'active',
        on: () => undefined,
        removeListener: () => undefined
    };
}

function createShortcutRegistrar(): ShortcutRegistrar {
    return {
        register: () => true,
        unregister: () => undefined
    };
}

function createTray(): TrayLike {
    return {
        setContextMenu: () => undefined,
        destroy: () => undefined
    };
}

export interface ProductionSmokeFixture {
    dispose(): Promise<void>;
    snapshot(): {
        captureCount: number;
        activeCaptureCount: number;
        captureBufferCleared: boolean;
    };
    readonly providerSummary: ProviderSummary;
    readonly systemIntegration: SystemIntegration;
    readonly screenshot: ScreenshotService;
    readonly memory: MemoryDatabase;
}

export async function createProductionSmokeFixture(
    scratchDir: string
): Promise<ProductionSmokeFixture> {
    const providerServer = await createProviderServer();
    const database = new MemoryDatabase({
        databasePath: join(scratchDir, 'memory.sqlite3'),
        workerPath: join(__dirname, 'memoryWorker.js'),
        now: () => new Date()
    });
    await database.recordTranslation(completedTask('seed-hello', 'Hello', 'Bonjour'));
    await database.recordTranslation(completedTask('seed-goodbye', 'Goodbye', 'Adiós'));
    await database.recordTranslation(completedTask('seed-thanks', 'Thanks', 'Merci'));
    await database.recordTranslation(completedTask('seed-image', 'Image text', 'Image text'));

    const secureConfig = new SecureConfigService({
        storagePath: join(scratchDir, 'providers.json'),
        safeStorage: createSafeStorage(),
        fetchImpl: providerServer.fetchImpl
    });
    const providerSummary = await secureConfig.saveProvider({
        name: 'Local smoke provider',
        baseUrl: 'https://provider.invalid/v1',
        apiKey: secret,
        textModel: 'text-model',
        visionModel: 'vision-model',
        targetLanguage: 'fr',
        streaming: true
    });
    const providerConfig = async (): Promise<ProviderConfig> => ({
        id: providerSummary.id,
        name: providerSummary.name,
        baseUrl: 'https://provider.invalid/v1',
        apiKey: secret,
        textModel: providerSummary.textModel,
        visionModel: providerSummary.visionModel,
        targetLanguage: 'fr',
        streaming: true
    });
    const openAiClient = new OpenAiClient({
        fetchImpl: providerServer.fetchImpl
    });
    const translationRunner: TranslationRunner = {
        run: async (
            request: TranslationRunnerRequest,
            signal?: AbortSignal,
            onDelta?: (delta: string) => void
        ) => openAiClient.translateText({
            provider: request.provider,
            sourceText: request.sourceText,
            context: request.context,
            targetLanguage: request.targetLanguage
        }, signal, onDelta)
    };
    const imageRunner: ImageTranslationRunner = {
        runImage: async (
            request: ImageTranslationRunnerRequest,
            signal?: AbortSignal,
            onDelta?: (delta: string) => void
        ) => openAiClient.translateImage({
            provider: request.provider,
            image: request.image,
            context: request.context,
            targetLanguage: request.targetLanguage,
            structuredResponse: request.structuredResponse
        }, signal, onDelta)
    };
    const captureBuffers: Buffer[] = [];
    let captureCount = 0;
    const screenshot = new ScreenshotService({
        captureAdapter: {
            captureClippedRegion: async (request) => {
                const data = Buffer.alloc(
                    Math.min(512 * 1024, request.width * request.height),
                    0x5a
                );
                captureBuffers.push(data);
                captureCount += 1;
                return {
                    data,
                    mimeType: 'image/jpeg',
                    width: request.width,
                    height: request.height
                };
            }
        },
        translationRunner: imageRunner,
        getProvider: providerConfig,
        getDisplays: () => [displayBounds],
        mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
        recordTranslation: (task) => database.recordTranslation(task)
    });
    const selection = new SelectionService({
        captureAdapter: {
            readAccessibilitySelection: async () => 'Hello',
            copySelectionToClipboard: async () => undefined,
            readClipboardText: async () => 'Hello',
            saveClipboard: async () => undefined,
            restoreClipboard: async () => undefined
        },
        translationRunner,
        getProvider: providerConfig,
        recordTranslation: (task) => database.recordTranslation(task)
    });
    const quiz = new QuizScheduler({
        repository: database,
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    const systemIntegration = new SystemIntegration({
        shortcutRegistrar: createShortcutRegistrar(),
        tray: createTray(),
        buildMenu: () => undefined,
        powerMonitor: createPowerMonitor(),
        onSelectionShortcut: () => undefined,
        onScreenshotShortcut: () => undefined,
        onShow: () => undefined,
        onOpenSettings: () => undefined,
        onCheckUpdates: () => undefined,
        onPausedChange: (paused) => {
            void quiz.setQuizPreferences({ paused });
        },
        onExit: () => undefined
    });
    const disposeRouter = registerIpcRouter({
        ipcMain,
        secureConfig,
        selection,
        screenshot,
        memory: database,
        quiz,
        getPerformanceMode: () => systemIntegration.getPerformanceMode(),
        getResourcePressure: getElectronResourcePressureMetrics,
        isSenderAuthorized: () => true
    });
    return {
        providerSummary,
        systemIntegration,
        screenshot,
        memory: database,
        snapshot: () => ({
            captureCount,
            activeCaptureCount: screenshot.activeCaptureCount(),
            captureBufferCleared: captureBuffers.splice(0).every((buffer) => (
                buffer.every((value) => value === 0)
            ))
        }),
        dispose: async () => {
            disposeRouter();
            await systemIntegration.dispose();
            await database.close();
            await providerServer.close();
        }
    };
}

async function measureInteractionLatency(
    window: BrowserWindow
): Promise<{ latencyMs: number; basis: string }> {
    const result = await window.webContents.executeJavaScript(`(async () => {
        const stage = document.querySelector('[data-testid="live2d-stage"]') ?? document.body;
        stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
            latencyMs: Number(stage.dataset.interactionLatencyMs ?? 0),
            basis: stage.dataset.interactionLatencyBasis ?? ''
        };
    })()`) as { latencyMs: number; basis: string };
    return result;
}

export async function runProductionFullFlow(
    window: BrowserWindow,
    fixture: ProductionSmokeFixture
): Promise<Record<string, unknown>> {
    const beforePause = await window.webContents.executeJavaScript(
        'window.desktopPet.getPerformanceMode()'
    );
    fixture.systemIntegration.togglePaused();
    const paused = await window.webContents.executeJavaScript(
        'window.desktopPet.getPerformanceMode()'
    );
    fixture.systemIntegration.togglePaused();
    const afterResume = await window.webContents.executeJavaScript(
        'window.desktopPet.getPerformanceMode()'
    );
    const pressureObservation = window.webContents.executeJavaScript(`(async () => {
        const stage = document.querySelector('[data-testid="live2d-stage"]');
        const observed = [];
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            const startedAt = performance.now();
            stage?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            while (performance.now() - startedAt < 300) {
                Math.sqrt(performance.now());
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
            const metrics = await window.desktopPet.getResourcePressure();
            observed.push({
                renderMode: stage?.getAttribute('data-render-mode') ?? 'missing',
                resourceMode: stage?.getAttribute('data-resource-mode') ?? 'missing',
                privateBytes: metrics.privateBytes
            });
            if (observed.some((item) => item.resourceMode === 'static'))
                break;
        }
        while (Date.now() < deadline) {
            const metrics = await window.desktopPet.getResourcePressure();
            observed.push({
                renderMode: stage?.getAttribute('data-render-mode') ?? 'missing',
                resourceMode: stage?.getAttribute('data-resource-mode') ?? 'missing',
                privateBytes: metrics.privateBytes
            });
            if (
                observed.some((item) => item.resourceMode === 'reduced')
                && observed.some((item) => item.resourceMode === 'static')
                && observed.some((item, index) => (
                    index > 0
                    && item.renderMode === 'live2d'
                    && observed[index - 1].renderMode === 'static-fallback'
                ))
            )
                break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return observed;
    })()`) as Promise<Array<{
        renderMode: string;
        resourceMode: string;
        privateBytes: number;
    }>>;
    const pressure = await pressureObservation;
    const reducedObserved = pressure.some((item) => item.resourceMode === 'reduced');
    const staticObserved = pressure.some((item) => item.resourceMode === 'static');
    const recoveredRenderMode = pressure.at(-1)?.renderMode ?? 'missing';
    if (
        !reducedObserved
        || !staticObserved
        || recoveredRenderMode !== 'live2d'
    )
        throw new Error(
            `Resource pressure transition failed: ${JSON.stringify(pressure)}`
        );
    const interaction = await measureInteractionLatency(window);
    const result = await window.webContents.executeJavaScript(`(async () => {
        const secret = ${JSON.stringify(secret)};
        const capture = await window.desktopPet.captureSelectionOnce('full-flow-capture');
        const selection = await window.desktopPet.translateSelection({
            sourceText: 'Hello'
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
        const entries = await window.desktopPet.vocabulary.listEntries();
        const question = await window.desktopPet.quiz.selectQuizQuestions(1);
        const feedback = question[0] === undefined
            ? undefined
            : await window.desktopPet.quiz.recordQuizAnswer(
                question[0].id,
                question[0].options.indexOf('Bonjour')
            );
        const updatedEntries = await window.desktopPet.vocabulary.listEntries();
        await window.desktopPet.quiz.setQuizPreferences({ paused: true });
        const pausedQuestions = await window.desktopPet.quiz.selectQuizQuestions(1);
        const provider = await window.desktopPet.getProviderSummaries();
        const details = await window.desktopPet.getProviderDetails(provider[0].id);
        return {
            selection: {
                sourceText: capture.sourceText,
                translatedText: selection.translatedText,
                memoryStatus: selection.memoryStatus?.state
            },
            screenshot: {
                translatedText: screenshot.translatedText,
                sourceText: heat.find((item) => item.translatedText === screenshot.translatedText)?.sourceText
            },
            providerError: {
                code: failed.errorCode,
                message: failed.error
            },
            memoryHeat: {
                sourceText: heat[0]?.sourceText,
                occurrenceCount: heat[0]?.occurrenceCount,
                entryCount: entries.length
            },
            quiz: {
                scheduledIntervalDays: question[0] === undefined
                    ? 0
                    : updatedEntries.find((entry) => entry.id === question[0].id)
                        ?.quizIntervalDays ?? 0,
                selectedBeforePause: question.length,
                selectedWhilePaused: pausedQuestions.length
            },
            secret: {
                masked: '••••••••',
                hasApiKey: provider[0]?.hasApiKey === true,
                exposedSecretFields: [
                    ...Object.keys(provider[0] ?? {}),
                    ...Object.keys(details)
                ].filter((key) => (
                    key !== 'hasApiKey'
                    && /api.?key|secret|token|password/i.test(key)
                )),
                leaked: JSON.stringify({ provider, details }).includes(secret)
            }
        };
    })()`) as Record<string, unknown>;
    return {
        ...result,
        screenshot: {
            ...(result.screenshot as Record<string, unknown>),
            captureCount: fixture.snapshot().captureCount,
            retainedScreenshotBytes: 0,
            activeCaptureCount: fixture.snapshot().activeCaptureCount,
            captureBufferCleared: fixture.snapshot().captureBufferCleared
        },
        pause: {
            before: beforePause,
            paused,
            afterResume
        },
        resourcePressure: {
            reducedObserved,
            staticObserved,
            recoveredRenderMode,
            privateMemoryBasis: 'electron-app-metrics-private-bytes',
            interactionLatencyBasis: interaction.basis
        }
    };
}

export async function runProductionResourceProfile(
    window: BrowserWindow,
    fixture: ProductionSmokeFixture
): Promise<Record<string, unknown>> {
    const idleWaitMs = Math.max(0, Number(process.env.DESKTOP_PET_PROFILE_IDLE_MS ?? 0));
    await delay(2_000);
    const idleStartedAtMs = Date.now();
    await delay(idleWaitMs);
    const idleEndedAtMs = Date.now();
    const activeBefore = getElectronPrivateBytes();
    app.getAppMetrics();
    const activeStartedAt = Date.now();
    await window.webContents.executeJavaScript(`(async () => {
        for (let index = 0; index < 24; index += 1)
            await window.desktopPet.translateSelection({ sourceText: 'Hello' });
        for (let index = 0; index < 12; index += 1)
            await window.desktopPet.translateScreenshot({
                x: 10,
                y: 20,
                width: 320,
                height: 200
            });
    })()`);
    const activeDurationMs = Math.max(1, Date.now() - activeStartedAt);
    const activeCpuPercent = app.getAppMetrics().reduce(
        (total, metric) => total + metric.cpu.percentCPUUsage,
        0
    );
    const activeAfter = getElectronPrivateBytes();
    const peakSamples: number[] = [];
    const sampler = setInterval(() => {
        peakSamples.push(getElectronPrivateBytes());
    }, 1);
    await window.webContents.executeJavaScript(
        `window.desktopPet.translateScreenshot({
            x: 10,
            y: 20,
            width: 320,
            height: 200
        })`
    );
    clearInterval(sampler);
    const screenshotPeakPrivateBytes = Math.max(activeAfter, ...peakSamples);
    const driftStartPrivateBytes = getElectronPrivateBytes();
    const driftStartedAt = Date.now();
    const driftSamples = await window.webContents.executeJavaScript(`(async () => {
        const samples = [];
        for (let cycle = 0; cycle < 480; cycle += 1) {
            await window.desktopPet.vocabulary.queryHeat();
            const metrics = await window.desktopPet.getResourcePressure();
            samples.push(metrics.privateBytes);
        }
        return samples;
    })()`) as number[];
    const driftWallClockDurationMs = Date.now() - driftStartedAt;
    const interaction = await measureInteractionLatency(window);
    return {
        activeCpuPercent,
        activeCpuBasis: 'electron-app-metrics-active-work-window',
        activeWindowMs: activeDurationMs,
        idleStartedAtMs,
        idleEndedAtMs,
        normalPrivateBytes: activeBefore,
        peakPrivateBytes: screenshotPeakPrivateBytes,
        screenshotPeakPrivateBytes,
        driftPeakPrivateBytes: Math.max(activeAfter, ...driftSamples),
        driftStartPrivateBytes,
        driftWallClockDurationMs,
        screenshotPeakBasis: 'electron-app-metrics-private-bytes-fine-sampled',
        interactionLatencyMs: interaction.latencyMs,
        interactionLatencyBasis: interaction.basis,
        interactionSamples: 1,
        driftSamples,
        screenshotCaptureCount: fixture.snapshot().captureCount
    };
}
