import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    translationTaskSchema,
    type CapturedImage,
    type ProviderConfig,
    type ScreenBounds
} from '../../src/shared/contracts';
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

const bounds: ScreenBounds = { x: 0, y: 0, width: 10, height: 10 };
const provider: ProviderConfig = {
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
        getCaptureBounds: () => bounds,
        mapBoundsToCapturePixels: (value) => value,
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
            targetLanguage: 'zh-CN'
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
                JSON.stringify({ error: { message: 'synthetic unsupported vision' } }),
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
});
