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
    providerConfigSchema,
    translationErrorCodeSchema,
    type ProviderErrorCode
} from '../../shared/contracts';
import {
    OpenAiClient,
    ProviderError,
    providerErrorMessage,
    type TextTranslationRequest,
    type TranslationDeltaHandler,
    type TranslationResult
} from '../services/openAiClient';

export interface TranslationRunnerRequest extends TextTranslationRequest {
    taskId: string;
}

export interface TranslationRunner {
    run(
        request: TranslationRunnerRequest,
        signal?: AbortSignal,
        onDelta?: TranslationDeltaHandler
    ): Promise<TranslationResult>;
}

export interface TranslationWorkerRunnerOptions {
    workerPath: string;
    workerFactory?: (filename: string, options: WorkerOptions) => Worker;
}

const translationRunnerRequestSchema = z.strictObject({
    taskId: z.string().min(1).max(128),
    provider: providerConfigSchema,
    sourceText: z.string().min(1).max(MAX_SOURCE_TEXT_CHARS),
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

function safeFailureCode(error: unknown): ProviderErrorCode {
    if (error instanceof ProviderError)
        return error.code;
    return 'network';
}

function safeFailure(error: unknown, taskId: string): WorkerMessage {
    const code = safeFailureCode(error);
    return {
        type: 'failed',
        taskId,
        code,
        message: providerErrorMessage(code)
    };
}

async function runWorker(request: TranslationRunnerRequest): Promise<void> {
    const parsed = translationRunnerRequestSchema.safeParse(request);
    if (!parsed.success || parentPort === null) {
        parentPort?.postMessage({
            type: 'failed',
            taskId: request?.taskId ?? '',
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
        const result = await new OpenAiClient().translateText(
            {
                provider: parsed.data.provider,
                sourceText: parsed.data.sourceText,
                context: parsed.data.context,
                targetLanguage: parsed.data.targetLanguage
            },
            undefined,
            emitDelta
        );
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

export class TranslationWorkerRunner implements TranslationRunner {
    private readonly workerPath: string;
    private readonly workerFactory: (filename: string, options: WorkerOptions) => Worker;

    constructor(options: TranslationWorkerRunnerOptions) {
        this.workerPath = options.workerPath;
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
        const parsed = translationRunnerRequestSchema.safeParse(request);
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
                        resolve({
                            translatedText: message.translatedText,
                            model: message.model
                        });
                    });
                    return;
                }
                finish(() => {
                    void worker.terminate();
                    reject(new ProviderError(toProviderErrorCode(message.code)));
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
}

if (!isMainThread && parentPort !== null)
    void runWorker(workerData as TranslationRunnerRequest);
