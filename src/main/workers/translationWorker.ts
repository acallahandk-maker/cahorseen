import {
    isMainThread,
    parentPort,
    workerData,
    Worker,
    type WorkerOptions
} from 'node:worker_threads';
import { z } from 'zod';
import {
    MAX_CONTEXT_CHARS,
    MAX_SOURCE_TEXT_CHARS,
    MAX_TARGET_LANGUAGE_CHARS,
    MAX_TRANSLATED_TEXT_CHARS,
    MAX_TRANSLATION_DELTA_CHARS,
    capturedImageSchema,
    providerConfigSchema,
    translationErrorCodeSchema,
    type ProviderErrorCode,
    type MemoryPersistenceStatus,
    type ScreenBounds,
    type TranslationTask
} from '../../shared/contracts';
import {
    OpenAiClient,
    ProviderError,
    UnsupportedVisionError,
    providerErrorMessage,
    type ImageTranslationRequest,
    type TextTranslationRequest,
    type TranslationDeltaHandler,
    type TranslationResult
} from '../services/openAiClient';
import {
    memoryFailureStatus,
    memoryRecordedStatus
} from '../services/memoryDatabase';

export { UnsupportedVisionError };

export interface TranslationRunnerRequest extends TextTranslationRequest {
    taskId: string;
    kind?: 'text';
}

export interface ImageTranslationRunnerRequest extends ImageTranslationRequest {
    taskId: string;
    kind: 'image';
}

export interface TranslationRunner {
    run(
        request: TranslationRunnerRequest,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult>;
}

export interface ImageTranslationRunner {
    runImage(
        request: ImageTranslationRunnerRequest,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult>;
}

export interface TranslationWorkerRunnerOptions {
    workerPath: string;
    workerFactory?: (filename: string, options: WorkerOptions) => Worker;
    onTaskCompleted?: (task: TranslationTask) => void | Promise<void>;
    onMemoryStatus?: (status: MemoryPersistenceStatus) => void;
}

const textTranslationRunnerRequestSchema = z.strictObject({
    taskId: z.string().min(1).max(128),
    kind: z.literal('text').optional(),
    provider: providerConfigSchema,
    sourceText: z.string().min(1).max(MAX_SOURCE_TEXT_CHARS),
    context: z.string().max(MAX_CONTEXT_CHARS).optional(),
    targetLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS)
});

const imageTranslationRunnerRequestSchema = z.strictObject({
    taskId: z.string().min(1).max(128),
    kind: z.literal('image'),
    provider: providerConfigSchema,
    image: capturedImageSchema,
    context: z.string().max(MAX_CONTEXT_CHARS).optional(),
    targetLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS)
});

const workerMessageSchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('delta'),
        taskId: z.string().min(1),
        delta: z.string().max(MAX_TRANSLATION_DELTA_CHARS)
    }),
    z.strictObject({
        type: z.literal('completed'),
        taskId: z.string().min(1),
        translatedText: z.string().max(MAX_TRANSLATED_TEXT_CHARS),
        model: z.string().min(1)
    }),
    z.strictObject({
        type: z.literal('failed'),
        taskId: z.string().min(1),
        code: translationErrorCodeSchema,
        message: z.string().max(500)
    })
]);

type WorkerMessage = z.infer<typeof workerMessageSchema>;
type WorkerFailureCode = ProviderErrorCode | 'unsupported-vision';

export function createDeltaEmitter(
    post: (delta: string) => void
): (delta: string) => void {
    return (delta) => {
        for (let offset = 0; offset < delta.length; offset += MAX_TRANSLATION_DELTA_CHARS)
            post(delta.slice(offset, offset + MAX_TRANSLATION_DELTA_CHARS));
    };
}

function toProviderErrorCode(code: z.infer<typeof translationErrorCodeSchema>): ProviderErrorCode {
    return code === 'aborted'
        || code === 'authentication'
        || code === 'invalid-config'
        || code === 'invalid-request'
        || code === 'invalid-response'
        || code === 'invalid-storage'
        || code === 'network'
        || code === 'provider-not-found'
        || code === 'rate-limited'
        || code === 'server'
        || code === 'storage-error'
        || code === 'storage-unavailable'
        || code === 'timeout'
        ? code
        : 'network';
}

function safeFailureCode(error: unknown): WorkerFailureCode {
    if (error instanceof UnsupportedVisionError)
        return error.code;
    if (error instanceof ProviderError)
        return error.code;
    return 'network';
}

function safeFailure(error: unknown, taskId: string): WorkerMessage {
    const code = safeFailureCode(error);
    const message = code === 'unsupported-vision'
        ? new UnsupportedVisionError().message
        : providerErrorMessage(code);
    return {
        type: 'failed',
        taskId,
        code,
        message
    };
}

function runnerError(code: z.infer<typeof translationErrorCodeSchema>): Error {
    return code === 'unsupported-vision'
        ? new UnsupportedVisionError()
        : new ProviderError(toProviderErrorCode(code));
}

type RunnerRequest = TranslationRunnerRequest | ImageTranslationRunnerRequest;

export function createCompletedSelectionTask(
    request: TranslationRunnerRequest,
    result: TranslationResult
): TranslationTask {
    return {
        id: request.taskId,
        status: 'completed',
        kind: 'selection',
        sourceText: request.sourceText,
        translatedText: result.translatedText,
        targetLanguage: request.targetLanguage,
        retryInput: {
            kind: 'selection',
            strategy: 'reuse-source',
            sourceText: request.sourceText
        }
    };
}

export function createCompletedScreenshotTask(
    request: ImageTranslationRunnerRequest,
    result: TranslationResult,
    bounds: ScreenBounds
): TranslationTask {
    return {
        id: request.taskId,
        status: 'completed',
        kind: 'screenshot',
        sourceText: 'Screenshot region',
        translatedText: result.translatedText,
        sourceLanguage: 'und',
        targetLanguage: request.targetLanguage,
        bounds,
        retryInput: {
            kind: 'screenshot',
            strategy: 'recapture',
            bounds
        }
    };
}

async function runWorker(request: RunnerRequest): Promise<void> {
    const isImageRequest = (request as { kind?: unknown }).kind === 'image';
    const parsed = isImageRequest
        ? imageTranslationRunnerRequestSchema.safeParse(request)
        : textTranslationRunnerRequestSchema.safeParse(request);
    if (!parsed.success || parentPort === null) {
        const taskId = typeof (request as { taskId?: unknown })?.taskId === 'string'
            ? (request as { taskId: string }).taskId
            : '';
        parentPort?.postMessage({
            type: 'failed',
            taskId,
            code: 'invalid-config',
            message: providerErrorMessage('invalid-config')
        } satisfies WorkerMessage);
        return;
    }

    try {
        const emitDelta = createDeltaEmitter((delta) => {
            parentPort?.postMessage({
                type: 'delta',
                taskId: parsed.data.taskId,
                delta
            } satisfies WorkerMessage);
        });
        const client = new OpenAiClient();
        const result = parsed.data.kind === 'image'
            ? await client.translateImage({
                provider: parsed.data.provider,
                image: parsed.data.image,
                context: parsed.data.context,
                targetLanguage: parsed.data.targetLanguage
            }, undefined, emitDelta)
            : await client.translateText({
                provider: parsed.data.provider,
                sourceText: parsed.data.sourceText,
                context: parsed.data.context,
                targetLanguage: parsed.data.targetLanguage
            }, undefined, emitDelta);
        parentPort.postMessage({
            type: 'completed',
            taskId: parsed.data.taskId,
            translatedText: result.translatedText,
            model: result.model
        } satisfies WorkerMessage);
    } catch (error) {
        parentPort.postMessage(safeFailure(error, parsed.data.taskId) satisfies WorkerMessage);
    }
}

export class TranslationWorkerRunner implements TranslationRunner, ImageTranslationRunner {
    private readonly workerPath: string;
    private readonly workerFactory: (filename: string, options: WorkerOptions) => Worker;
    private readonly onTaskCompleted: ((task: TranslationTask) => void | Promise<void>) | undefined;
    private readonly onMemoryStatus: ((status: MemoryPersistenceStatus) => void) | undefined;

    constructor(options: TranslationWorkerRunnerOptions) {
        this.workerPath = options.workerPath;
        this.onTaskCompleted = options.onTaskCompleted;
        this.onMemoryStatus = options.onMemoryStatus;
        this.workerFactory = options.workerFactory ?? ((filename, workerOptions) => new Worker(
            filename,
            workerOptions
        ));
    }

    run(
        request: TranslationRunnerRequest,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult> {
        return this.runRequest(request, textTranslationRunnerRequestSchema, signal, onDelta);
    }

    runImage(
        request: ImageTranslationRunnerRequest,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult> {
        return this.runRequest(
            request,
            imageTranslationRunnerRequestSchema,
            signal,
            onDelta
        );
    }

    private runRequest<TRequest extends RunnerRequest>(
        request: TRequest,
        requestSchema: z.ZodType<TRequest>,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult> {
        const parsed = requestSchema.safeParse(request);
        if (!parsed.success)
            return Promise.reject(new ProviderError('invalid-config'));
        if (signal?.aborted === true)
            return Promise.reject(new ProviderError('aborted'));

        return new Promise<TranslationResult>((resolve, reject) => {
            let settled = false;
            const worker = this.workerFactory(this.workerPath, {
                workerData: parsed.data
            });
            const finish = (
                action: () => void
            ): void => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                action();
            };
            const abort = (): void => {
                finish(() => {
                    void worker.terminate();
                    reject(new ProviderError('aborted'));
                });
            };

            signal?.addEventListener('abort', abort, { once: true });
            worker.on('message', (raw: unknown) => {
                if (settled)
                    return;
                const parsedMessage = workerMessageSchema.safeParse(raw);
                if (!parsedMessage.success || parsedMessage.data.taskId !== parsed.data.taskId) {
                    finish(() => {
                        void worker.terminate();
                        reject(new ProviderError('invalid-response'));
                    });
                    return;
                }

                const message = parsedMessage.data;
                if (message.type === 'delta') {
                    onDelta?.(message.delta);
                    return;
                }
                if (message.type === 'completed') {
                    finish(() => {
                        void worker.terminate();
                        const result: TranslationResult = {
                            translatedText: message.translatedText,
                            model: message.model
                        };
                        if (parsed.data.kind === 'image') {
                            resolve(result);
                            return;
                        }
                        void this.persistCompletedSelection(parsed.data, result).then(resolve);
                    });
                    return;
                }
                finish(() => {
                    void worker.terminate();
                    reject(runnerError(message.code));
                });
            });
            worker.once('error', () => {
                finish(() => {
                    reject(new ProviderError('network'));
                });
            });
            worker.once('exit', (code) => {
                finish(() => {
                    if (code === 0)
                        reject(new ProviderError('invalid-response'));
                    else
                        reject(new ProviderError('aborted'));
                });
            });
        });
    }

    private async persistCompletedSelection(
        request: TranslationRunnerRequest,
        result: TranslationResult
    ): Promise<TranslationResult> {
        if (this.onTaskCompleted === undefined)
            return result;
        try {
            await this.onTaskCompleted(createCompletedSelectionTask(request, result));
            this.notifyMemoryStatus(memoryRecordedStatus());
            return result;
        } catch (error) {
            const status = memoryFailureStatus(error);
            this.notifyMemoryStatus(status);
            return { ...result, memoryStatus: status };
        }
    }

    private notifyMemoryStatus(status: MemoryPersistenceStatus): void {
        try {
            this.onMemoryStatus?.(status);
        } catch {
            return;
        }
    }
}

if (!isMainThread && parentPort !== null)
    void runWorker(workerData as RunnerRequest);
