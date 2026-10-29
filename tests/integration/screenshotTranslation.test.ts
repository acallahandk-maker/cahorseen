import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    screenshotIpcChannels,
    screenshotTranslationStartSchema,
    translationTaskSchema,
    type CapturedImage,
    type ProviderConfig,
    type ScreenBounds,
    type TranslationTask
} from '../../src/shared/contracts';
import {
    registerIpcRouter,
    type ScreenshotIpcService
} from '../../src/main/ipcRouter';
import {
    ScreenshotOverlayController,
    type ScreenshotOverlayOwner,
    type ScreenshotOverlayWindowLike,
    type ScreenshotOverlayWindowOptions
} from '../../src/main/screenshotOverlay';
import {
    OpenAiClient,
    ProviderError
} from '../../src/main/services/openAiClient';
import {
    ScreenshotService,
    UnsupportedVisionError,
    type EncodedScreenshot,
    type ScreenshotCaptureAdapter
} from '../../src/main/services/screenshotService';
import {
    TranslationWorkerRunner,
    type ImageTranslationRunner,
    type ImageTranslationRunnerRequest
} from '../../src/main/workers/translationWorker';
import {
    registerScreenshotShortcut,
    type SelectionShortcutRegistrar
} from '../../src/main/selectionShortcut';
import { clipRegionSelection } from '../../src/renderer/screenshot/regionSelection';

const bounds: ScreenBounds = { x: 0, y: 0, width: 10, height: 10 };
const provider: ProviderConfig = {
    id: 'synthetic-provider',
    name: 'Synthetic',
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'synthetic-key',
    textModel: 'text-model',
    visionModel: 'vision-model',
    targetLanguage: 'zh-CN'
};

function captureAdapter(): ScreenshotCaptureAdapter {
    return {
        captureClippedRegion: vi.fn(async (): Promise<EncodedScreenshot> => ({
            data: Buffer.from('synthetic-image'),
            mimeType: 'image/jpeg',
            width: 10,
            height: 10
        }))
    };
}

function service(
    translationRunner: ImageTranslationRunner,
    adapter = captureAdapter()
): ScreenshotService {
    return new ScreenshotService({
        captureAdapter: adapter,
        translationRunner,
        getProvider: async () => provider,
        getDisplays: () => [bounds],
        mapBoundsToCapturePixels: (_displayIndex, value) => value,
        maxDimension: 100,
        createId: () => 'screenshot-task'
    });
}

describe('screenshot translation', () => {
    it('translates a captured screenshot through the bounded vision runner', async () => {
        let sentImage: CapturedImage | undefined;
        const runImage = vi.fn(async (request: ImageTranslationRunnerRequest) => {
            sentImage = request.image;
            return { translatedText: 'translated', model: 'vision-model' };
        });

        const task = await service({ runImage }).translateScreenshot(bounds);

        expect(translationTaskSchema.parse(task)).toEqual({
            id: 'screenshot-task',
            status: 'completed',
            sourceText: 'Screenshot region',
            translatedText: 'translated',
            sourceLanguage: 'und',
            targetLanguage: 'zh-CN',
            providerId: 'synthetic-provider',
            providerName: 'Synthetic',
            textModel: 'text-model',
            visionModel: 'vision-model',
            translationModel: 'vision-model'
        });
        expect(runImage).toHaveBeenCalledTimes(1);
        expect(runImage.mock.calls[0][0]).toMatchObject({
            kind: 'image',
            taskId: 'screenshot-task',
            targetLanguage: 'zh-CN'
        });
        expect(runImage.mock.calls[0][0]).not.toHaveProperty('sourceText');
        expect(sentImage?.dataUrl).toBe('');
        expect(sentImage?.byteLength).toBe(0);
    });

    it('returns a typed unsupported-vision error and releases the screenshot', async () => {
        let sentImage: CapturedImage | undefined;
        const runImage = vi.fn(async (request: ImageTranslationRunnerRequest) => {
            sentImage = request.image;
            throw new UnsupportedVisionError();
        });

        const task = await service({ runImage }).translateScreenshot(bounds);

        expect(translationTaskSchema.parse(task)).toMatchObject({
            status: 'failed',
            errorCode: 'unsupported-vision',
            error: 'Vision translation is not supported. Choose a vision-capable model.'
        });
        expect(sentImage?.dataUrl).toBe('');
        expect(sentImage?.byteLength).toBe(0);
    });

    it('preserves provider error codes and releases the screenshot on failure', async () => {
        let sentImage: CapturedImage | undefined;
        const runImage = vi.fn(async (request: ImageTranslationRunnerRequest) => {
            sentImage = request.image;
            throw new ProviderError('rate-limited');
        });

        const task = await service({ runImage }).translateScreenshot(bounds);

        expect(translationTaskSchema.parse(task)).toMatchObject({
            status: 'failed',
            errorCode: 'rate-limited',
            error: 'Provider rate limit exceeded.'
        });
        expect(sentImage?.dataUrl).toBe('');
    });

    it('releases the screenshot when translation is cancelled', async () => {
        let sentImage: CapturedImage | undefined;
        let started!: () => void;
        const startedPromise = new Promise<void>((resolve) => {
            started = resolve;
        });
        const runImage = vi.fn((
            request: ImageTranslationRunnerRequest,
            signal?: AbortSignal
        ): Promise<never> => {
            sentImage = request.image;
            started();
            return new Promise<never>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new ProviderError('aborted')), {
                    once: true
                });
            });
        });
        const controller = new AbortController();

        const pending = service({ runImage }).translateScreenshot(bounds, {
            signal: controller.signal
        });
        await startedPromise;
        controller.abort();
        const task = await pending;

        expect(translationTaskSchema.parse(task)).toMatchObject({
            status: 'failed',
            errorCode: 'aborted'
        });
        expect(sentImage?.dataUrl).toBe('');
    });

    it('keeps synthetic provider secrets out of screenshot task results', async () => {
        const runImage = vi.fn(async (
            request: ImageTranslationRunnerRequest,
            signal?: AbortSignal
        ): Promise<{ translatedText: string; model: string }> => {
            void request;
            void signal;
            throw new Error(`synthetic failure ${provider.apiKey}`);
        });

        const task = await service({
            runImage: runImage as unknown as ImageTranslationRunner['runImage']
        }).translateScreenshot(bounds);

        expect(task.errorCode).toBe('request-failed');
        expect(JSON.stringify(task)).not.toContain(provider.apiKey);
    });

    it('maps unsupported image capability responses to a typed unsupported-vision error', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => new Response(
                JSON.stringify({
                    error: {
                        code: 'image_input_not_supported',
                        message: 'synthetic unsupported vision'
                    }
                }),
                { status: 400 }
            )
        });

        await expect(client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/jpeg;base64,c3ludGhldGlj',
                mimeType: 'image/jpeg',
                width: 1,
                height: 1,
                byteLength: 9
            },
            targetLanguage: 'zh-CN'
        })).rejects.toMatchObject({
            name: 'UnsupportedVisionError',
            code: 'unsupported-vision'
        });
    });

    it('recognizes model-not-found vision capability failures without exposing provider bodies', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => new Response(
                JSON.stringify({
                    error: {
                        code: 'model_not_found',
                        message: 'synthetic private provider detail'
                    }
                }),
                { status: 404 }
            )
        });

        const request = client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/jpeg;base64,c3ludGhldGlj',
                mimeType: 'image/jpeg',
                width: 1,
                height: 1,
                byteLength: 9
            },
            targetLanguage: 'zh-CN'
        });

        await expect(request).rejects.toMatchObject({
            name: 'UnsupportedVisionError',
            code: 'unsupported-vision',
            message: 'Vision translation is not supported. Choose a vision-capable model.'
        });
        await expect(request).rejects.not.toThrow(/synthetic private provider detail/);
    });

    it('preserves invalid-request errors for non-capability vision failures', async () => {
        const client = new OpenAiClient({
            fetchImpl: async () => new Response(
                JSON.stringify({
                    error: {
                        code: 'invalid_request',
                        message: 'synthetic malformed request detail'
                    }
                }),
                { status: 400 }
            )
        });

        const request = client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/jpeg;base64,c3ludGhldGlj',
                mimeType: 'image/jpeg',
                width: 1,
                height: 1,
                byteLength: 9
            },
            targetLanguage: 'zh-CN'
        });

        await expect(request).rejects.toMatchObject({
            name: 'ProviderError',
            code: 'invalid-request',
            message: 'Provider request is invalid.'
        });
        await expect(request).rejects.not.toThrow(/synthetic malformed request detail/);
    });

    it.each([
        { status: 401, code: 'authentication', message: 'Provider authentication failed.' },
        { status: 429, code: 'rate-limited', message: 'Provider rate limit exceeded.' },
        { status: 504, code: 'timeout', message: 'Provider request timed out.' },
        { status: 500, code: 'server', message: 'Provider service error.' }
    ])('preserves $code for non-capability vision HTTP $status failures', async ({
        status,
        code,
        message
    }) => {
        const client = new OpenAiClient({
            fetchImpl: async () => new Response(
                JSON.stringify({
                    error: {
                        code: 'image_input_not_supported',
                        message: 'synthetic misleading capability phrase'
                    }
                }),
                { status }
            )
        });

        await expect(client.translateImage({
            provider,
            image: {
                dataUrl: 'data:image/jpeg;base64,c3ludGhldGlj',
                mimeType: 'image/jpeg',
                width: 1,
                height: 1,
                byteLength: 9
            },
            targetLanguage: 'zh-CN'
        })).rejects.toMatchObject({
            name: 'ProviderError',
            code,
            message
        });
    });

    it('routes image tasks through the shared translation worker', async () => {
        const worker = new EventEmitter() as EventEmitter & {
            terminate: ReturnType<typeof vi.fn>;
        };
        worker.terminate = vi.fn();
        let sentWorkerData: unknown;
        const workerFactory = vi.fn(() => {
            queueMicrotask(() => worker.emit('message', {
                type: 'completed',
                taskId: 'worker-image-task',
                translatedText: 'translated',
                model: 'vision-model'
            }));
            return worker;
        });
        const typedWorkerFactory = (
            _filename: string,
            options: { workerData?: unknown }
        ) => {
            sentWorkerData = options.workerData;
            return workerFactory();
        };
        const runner = new TranslationWorkerRunner({
            workerPath: 'translationWorker.js',
            workerFactory: typedWorkerFactory as never
        });

        const result = await runner.runImage({
            kind: 'image',
            taskId: 'worker-image-task',
            provider,
            image: {
                dataUrl: 'data:image/jpeg;base64,c3ludGhldGlj',
                mimeType: 'image/jpeg',
                width: 1,
                height: 1,
                byteLength: 9
            },
            targetLanguage: 'zh-CN'
        });

        expect(result).toEqual({ translatedText: 'translated', model: 'vision-model' });
        expect(sentWorkerData).toMatchObject({
            kind: 'image',
            taskId: 'worker-image-task'
        });
        expect(sentWorkerData).not.toHaveProperty('sourceText');
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('ignores worker deltas that arrive after terminal completion', async () => {
        const worker = new EventEmitter() as EventEmitter & {
            terminate: ReturnType<typeof vi.fn>;
        };
        worker.terminate = vi.fn();
        const workerFactory = vi.fn(() => {
            queueMicrotask(() => {
                worker.emit('message', {
                    type: 'completed',
                    taskId: 'stale-delta-task',
                    translatedText: 'translated',
                    model: 'vision-model'
                });
                worker.emit('message', {
                    type: 'delta',
                    taskId: 'stale-delta-task',
                    delta: 'late'
                });
            });
            return worker;
        });
        const runner = new TranslationWorkerRunner({
            workerPath: 'translationWorker.js',
            workerFactory: workerFactory as never
        });
        const onDelta = vi.fn();

        const result = await runner.runImage({
            kind: 'image',
            taskId: 'stale-delta-task',
            provider,
            image: {
                dataUrl: 'data:image/jpeg;base64,c3ludGhldGlj',
                mimeType: 'image/jpeg',
                width: 1,
                height: 1,
                byteLength: 9
            },
            targetLanguage: 'zh-CN'
        }, undefined, onDelta);

        expect(result).toEqual({ translatedText: 'translated', model: 'vision-model' });
        expect(onDelta).not.toHaveBeenCalled();
    });

    it('wires screenshot shortcut selection bounds through validated translation IPC', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const screenshot: ScreenshotIpcService = {
            translateScreenshot: vi.fn(async (
                _bounds: ScreenBounds,
                options?: { taskId?: string; onTaskId?: (taskId: string) => void }
            ): Promise<TranslationTask> => {
                const taskId = options?.taskId ?? 'screenshot-ipc-task';
                options?.onTaskId?.(taskId);
                return {
                    id: taskId,
                    status: 'completed',
                    sourceText: 'Screenshot region',
                    translatedText: 'translated',
                    targetLanguage: 'zh-CN'
                };
            })
        };
        registerIpcRouter({
            ipcMain,
            secureConfig: {
                saveProvider: vi.fn(),
                setActiveProvider: vi.fn(),
                getProviderSummaries: vi.fn(async () => []),
                testProvider: vi.fn()
            },
            screenshot,
            isSenderAuthorized: () => true
        });
        let trigger: (() => void) | undefined;
        const shortcutRegistrar: SelectionShortcutRegistrar = {
            register: (_accelerator, listener) => {
                trigger = listener;
                return true;
            },
            unregister: vi.fn()
        };
        const sends: unknown[] = [];
        const event = {
            sender: {
                send: (channel: string, payload: unknown) => {
                    sends.push({ channel, payload });
                }
            }
        };
        const selection = clipRegionSelection(
            { x: 20, y: 10 },
            { x: 80, y: 50 },
            { x: 0, y: 0, width: 100, height: 80 }
        );
        expect(selection).not.toBeUndefined();
        registerScreenshotShortcut({
            shortcut: shortcutRegistrar,
            onTrigger: () => {
                void handlers.get(screenshotIpcChannels.translate)?.(event, {
                    bounds: selection
                });
            }
        });

        trigger?.();
        await vi.waitFor(() => {
            expect(screenshot.translateScreenshot).toHaveBeenCalledTimes(1);
        });

        expect(screenshot.translateScreenshot).toHaveBeenCalledWith(
            selection,
            expect.objectContaining({
                taskId: expect.any(String),
                signal: expect.any(AbortSignal)
            })
        );
        expect(sends).toEqual([
            {
                channel: 'desktop-pet:translation-event',
                payload: {
                    type: 'started',
                    taskId: expect.any(String)
                }
            },
            {
                channel: 'desktop-pet:translation-event',
                payload: {
                    type: 'completed',
                    task: {
                        id: expect.any(String),
                        status: 'completed',
                        sourceText: 'Screenshot region',
                        translatedText: 'translated',
                        targetLanguage: 'zh-CN'
                    }
                }
            }
        ]);
    });

    it('rejects malformed screenshot translation IPC payloads without invoking capture', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const screenshot: ScreenshotIpcService = {
            translateScreenshot: vi.fn()
        };
        registerIpcRouter({
            ipcMain,
            secureConfig: {
                saveProvider: vi.fn(),
                setActiveProvider: vi.fn(),
                getProviderSummaries: vi.fn(async () => []),
                testProvider: vi.fn()
            },
            screenshot,
            isSenderAuthorized: () => true
        });

        const result = await handlers.get(screenshotIpcChannels.translate)?.({}, {
            bounds: {
                x: 0,
                y: 0,
                width: 0,
                height: 10
            },
            unexpected: true
        });

        expect(result).toEqual({
            ok: false,
            error: {
                code: 'invalid-request',
                message: 'Screenshot translation request is invalid.'
            }
        });
        expect(screenshotTranslationStartSchema.safeParse({
            bounds: { x: 0, y: 0, width: 0, height: 10 },
            unexpected: true
        }).success).toBe(false);
        expect(screenshot.translateScreenshot).not.toHaveBeenCalled();
    });

    it('opens and closes the virtual-desktop selection surface before capture', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const order: string[] = [];
        let windowOptions: ScreenshotOverlayWindowOptions | undefined;
        let closedListener: (() => void) | undefined;
        const overlayWindow: ScreenshotOverlayWindowLike = {
            loadURL: vi.fn(async () => {
                order.push('load');
            }),
            show: vi.fn(() => {
                order.push('show');
            }),
            focus: vi.fn(() => {
                order.push('focus');
            }),
            close: vi.fn(() => {
                order.push('close');
                closedListener?.();
            }),
            isDestroyed: vi.fn(() => false),
            once: vi.fn((
                event: 'closed',
                listener: () => void
            ) => {
                if (event === 'closed')
                    closedListener = listener;
            })
        };
        const screenshot = {
            translateScreenshot: vi.fn(async (
                bounds: ScreenBounds
            ): Promise<TranslationTask> => {
                void bounds;
                return {
                    id: 'overlay-task',
                    status: 'completed',
                    sourceText: 'Screenshot region',
                    translatedText: 'translated',
                    targetLanguage: 'zh-CN'
                };
            })
        };
        const owner: ScreenshotOverlayOwner = {
            send: vi.fn((channel: string, payload: unknown) => {
                order.push(`send:${channel}`);
                if (channel === screenshotIpcChannels.selected) {
                    const bounds = (payload as { bounds: ScreenBounds }).bounds;
                    order.push('translate');
                    void screenshot.translateScreenshot(bounds);
                }
            })
        };
        const controller = new ScreenshotOverlayController({
            ipcMain,
            overlayUrl: 'file:///overlay',
            getDisplays: () => [
                { x: -1_920, y: -200, width: 1_920, height: 1_080 },
                { x: 0, y: 0, width: 2_560, height: 1_440 }
            ],
            createWindow: (options) => {
                windowOptions = options;
                order.push('open');
                return overlayWindow;
            },
            onSelected: (selectedBounds, selectedOwner) => {
                selectedOwner.send(screenshotIpcChannels.selected, {
                    bounds: selectedBounds
                });
            },
            isSenderAuthorized: () => true
        });
        let trigger: (() => void) | undefined;
        registerScreenshotShortcut({
            shortcut: {
                register: (_accelerator, listener) => {
                    trigger = listener;
                    return true;
                },
                unregister: vi.fn()
            },
            onTrigger: () => {
                void controller.open(owner);
            }
        });

        trigger?.();
        await vi.waitFor(() => expect(windowOptions).toBeDefined());
        await vi.waitFor(() => expect(overlayWindow.show).toHaveBeenCalledTimes(1));
        const result = await handlers.get(screenshotIpcChannels.select)?.({}, {
            bounds: {
                x: -1_800,
                y: -100,
                width: 2_000,
                height: 900
            }
        });

        expect(result).toEqual({ ok: true });
        expect(windowOptions?.bounds).toEqual({
            x: -1_920,
            y: -200,
            width: 4_480,
            height: 1_640
        });
        expect(order.indexOf('close')).toBeGreaterThan(-1);
        expect(order.indexOf('send:desktop-pet:screenshot-selected')).toBeGreaterThan(
            order.indexOf('close')
        );
        expect(order.indexOf('translate')).toBeGreaterThan(
            order.indexOf('send:desktop-pet:screenshot-selected')
        );
        expect(screenshot.translateScreenshot).toHaveBeenCalledWith({
            x: -1_800,
            y: -100,
            width: 2_000,
            height: 900
        });
        controller.dispose();
    });

    it('closes the screenshot selection surface on cancel without capture', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        let closed = false;
        const overlayWindow: ScreenshotOverlayWindowLike = {
            loadURL: vi.fn(async () => undefined),
            show: vi.fn(),
            focus: vi.fn(),
            close: vi.fn(() => {
                closed = true;
            }),
            isDestroyed: vi.fn(() => closed),
            once: vi.fn()
        };
        const onSelected = vi.fn();
        const controller = new ScreenshotOverlayController({
            ipcMain,
            overlayUrl: 'file:///overlay',
            getDisplays: () => [{
                x: -1_920,
                y: -200,
                width: 1_920,
                height: 1_080
            }],
            createWindow: () => overlayWindow,
            onSelected,
            isSenderAuthorized: () => true
        });
        await controller.open({ send: vi.fn() });

        const result = await handlers.get(screenshotIpcChannels.cancelSelection)?.({}, {});

        expect(result).toEqual({ ok: true });
        expect(overlayWindow.close).toHaveBeenCalledTimes(1);
        expect(onSelected).not.toHaveBeenCalled();
    });
});
