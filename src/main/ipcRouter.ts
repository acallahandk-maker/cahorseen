import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    connectionTestResultSchema,
    providerErrorCodeSchema,
    providerConfigSchema,
    providerSummarySchema,
    screenshotIpcChannels,
    screenshotTranslationStartSchema,
    translationCancelSchema,
    translationEventSchema,
    translationIpcChannels,
    translationStartSchema,
    type ConnectionTestResult,
    type ProviderErrorCode,
    type ProviderConfig,
    type ProviderSummary,
    type ScreenBounds,
    type SelectionCapture,
    type TranslationError,
    type TranslationTask
} from '../shared/contracts';
import {
    ProviderError,
    providerErrorMessage,
    validateProviderConfig
} from './services/openAiClient';
import type { SelectionTranslationOptions } from './services/selectionService';
import type { ScreenshotTranslationOptions } from './services/screenshotService';

export const providerIpcChannels = {
    save: 'desktop-pet:provider-save',
    setActive: 'desktop-pet:provider-set-active',
    summaries: 'desktop-pet:provider-summaries',
    test: 'desktop-pet:provider-test'
} as const;

export interface ProviderIpcService {
    saveProvider(config: ProviderConfig): Promise<ProviderSummary>;
    setActiveProvider(providerId: string): Promise<void>;
    getProviderSummaries(): Promise<ProviderSummary[]>;
    testProvider(
        providerId: string,
        capability: 'text' | 'vision'
    ): Promise<ConnectionTestResult>;
}

export interface SelectionIpcService {
    captureSelectionOnce(signal?: AbortSignal): Promise<SelectionCapture>;
    translateSelection(options?: SelectionTranslationOptions): Promise<TranslationTask>;
}

export interface ScreenshotIpcService {
    translateScreenshot(
        bounds: ScreenBounds,
        options?: ScreenshotTranslationOptions
    ): Promise<TranslationTask>;
}

export interface IpcMainLike {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void;
    removeHandler(channel: string): void;
}

export interface RegisterIpcRouterOptions {
    ipcMain: IpcMainLike;
    secureConfig: ProviderIpcService;
    selection?: SelectionIpcService;
    screenshot?: ScreenshotIpcService;
    isSenderAuthorized?: (event: unknown) => boolean;
}

type IpcFailure = {
    ok: false;
    error: {
        code: 'unauthorized' | 'invalid-request' | 'request-failed' | ProviderErrorCode | TranslationError['code'];
        message: string;
    };
};

type IpcSuccess<T> = {
    ok: true;
    value: T;
};

type IpcSaveSuccess = {
    ok: true;
};

const testPayloadSchema = z.strictObject({
    providerId: z.string().min(1),
    capability: z.enum(['text', 'vision'])
});

const setActivePayloadSchema = z.strictObject({
    providerId: z.string().min(1)
});

const emptyPayloadSchema = z.strictObject({});

export function getProductionRendererFileUrl(): string {
    return pathToFileURL(join(__dirname, '../renderer/index.html')).href;
}

function defaultIsSenderAuthorized(event: unknown): boolean {
    const senderFrame = (event as { senderFrame?: { url?: unknown } }).senderFrame;
    if (typeof senderFrame?.url !== 'string')
        return false;

    return senderFrame.url === getProductionRendererFileUrl()
        || (
            process.env.ELECTRON_RENDERER_URL !== undefined
            && senderFrame.url === process.env.ELECTRON_RENDERER_URL
        );
}

function failure(
    code: IpcFailure['error']['code'],
    message: string
): IpcFailure {
    return {
        ok: false,
        error: {
            code,
            message
        }
    };
}

function safeFailure(error: unknown): IpcFailure {
    if (error instanceof Error) {
        const code = (error as Error & { code?: unknown }).code;
        const parsedCode = providerErrorCodeSchema.safeParse(code);
        if (parsedCode.success)
            return failure(parsedCode.data, providerErrorMessage(parsedCode.data));
        if (['SecureConfigError', 'ProviderError'].includes(error.name))
            return failure('invalid-config', providerErrorMessage('invalid-config'));
    }
    return failure('request-failed', 'Provider request failed.');
}

function safeSelectionFailure(error: unknown): IpcFailure {
    if (error instanceof ProviderError)
        return safeFailure(error);
    const code = (error as { code?: unknown }).code;
    if (code === 'aborted')
        return failure('aborted', providerErrorMessage('aborted'));
    if (code === 'empty-selection')
        return failure('empty-selection', 'No selected text was found.');
    if (code === 'clipboard-read')
        return failure('clipboard-read', 'Selected text could not be read.');
    if (code === 'clipboard-restore')
        return failure('clipboard-restore', 'The original clipboard could not be restored.');
    if (code === 'invalid-selection')
        return failure('invalid-selection', 'Selected text is too large.');
    return failure('request-failed', 'Selection capture failed.');
}

function sendEvent(
    event: unknown,
    payload: Parameters<typeof translationEventSchema.parse>[0]
): void {
    const sender = (event as {
        sender?: { send?: (channel: string, payload: unknown) => void };
    }).sender;
    sender?.send?.(translationIpcChannels.event, translationEventSchema.parse(payload));
}

function taskFailure(task: TranslationTask): IpcFailure['error'] {
    return {
        code: task.errorCode ?? 'request-failed',
        message: task.error ?? 'Provider request failed.'
    };
}

export function registerIpcRouter(options: RegisterIpcRouterOptions): () => void {
    const { ipcMain, secureConfig, selection, screenshot } = options;
    const isSenderAuthorized = options.isSenderAuthorized ?? defaultIsSenderAuthorized;
    const activeTasks = new Map<string, AbortController>();

    ipcMain.handle(providerIpcChannels.save, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = providerConfigSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider configuration is invalid.');

        try {
            const summary = await secureConfig.saveProvider(
                validateProviderConfig(parsed.data)
            );
            return {
                ok: true,
                value: providerSummarySchema.parse(summary)
            } satisfies IpcSuccess<ProviderSummary>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(providerIpcChannels.setActive, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = setActivePayloadSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider selection is invalid.');

        try {
            await secureConfig.setActiveProvider(parsed.data.providerId);
            return { ok: true } satisfies IpcSaveSuccess;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(providerIpcChannels.summaries, async (event) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        try {
            const summaries = await secureConfig.getProviderSummaries();
            return {
                ok: true,
                value: summaries.map((summary) => providerSummarySchema.parse(summary))
            } satisfies IpcSuccess<ProviderSummary[]>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(providerIpcChannels.test, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = testPayloadSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider test request is invalid.');

        try {
            const result = await secureConfig.testProvider(
                parsed.data.providerId,
                parsed.data.capability
            );
            return {
                ok: true,
                value: connectionTestResultSchema.parse(result)
            } satisfies IpcSuccess<ConnectionTestResult>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    if (selection !== undefined) {
        ipcMain.handle(translationIpcChannels.captureSelection, async (event, payload) => {
            if (!isSenderAuthorized(event))
                return failure('unauthorized', 'IPC sender is not authorized.');
            if (payload !== undefined && !emptyPayloadSchema.safeParse(payload).success)
                return failure('invalid-request', 'Selection capture request is invalid.');

            try {
                const capture = await selection.captureSelectionOnce();
                return {
                    ok: true,
                    value: capture
                } satisfies IpcSuccess<SelectionCapture>;
            } catch (error) {
                return safeSelectionFailure(error);
            }
        });

        ipcMain.handle(translationIpcChannels.translateSelection, async (event, payload) => {
            if (!isSenderAuthorized(event))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = translationStartSchema.safeParse(payload ?? {});
            if (!parsed.success)
                return failure('invalid-request', 'Selection translation request is invalid.');

            const controller = new AbortController();
            const taskId = randomUUID();
            activeTasks.set(taskId, controller);
            const onTaskId = (startedTaskId: string): void => {
                if (startedTaskId !== taskId)
                    return;
                sendEvent(event, {
                    type: 'started',
                    taskId
                });
            };
            try {
                const task = await selection.translateSelection({
                    taskId,
                    signal: controller.signal,
                    onTaskId,
                    onDelta: (delta) => {
                        if (taskId !== undefined) {
                            sendEvent(event, {
                                type: 'delta',
                                taskId,
                                delta
                            });
                        }
                    }
                });
                if (task.status === 'completed') {
                    sendEvent(event, { type: 'completed', task });
                    return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
                }
                const error = taskFailure(task);
                sendEvent(event, { type: 'failed', taskId, error });
                return {
                    ok: false,
                    error
                };
            } catch (error) {
                const result = controller.signal.aborted
                    ? failure('aborted', providerErrorMessage('aborted'))
                    : safeSelectionFailure(error);
                sendEvent(event, {
                    type: 'failed',
                    taskId,
                    error: result.error
                });
                return result;
            } finally {
                activeTasks.delete(taskId);
            }
        });

    }

    if (screenshot !== undefined) {
        ipcMain.handle(screenshotIpcChannels.translate, async (event, payload) => {
            if (!isSenderAuthorized(event))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = screenshotTranslationStartSchema.safeParse(payload);
            if (!parsed.success)
                return failure('invalid-request', 'Screenshot translation request is invalid.');

            const controller = new AbortController();
            const taskId = randomUUID();
            activeTasks.set(taskId, controller);
            const onTaskId = (startedTaskId: string): void => {
                if (startedTaskId === taskId) {
                    sendEvent(event, {
                        type: 'started',
                        taskId
                    });
                }
            };
            try {
                const task = await screenshot.translateScreenshot(parsed.data.bounds, {
                    taskId,
                    signal: controller.signal,
                    onTaskId
                });
                if (task.status === 'completed') {
                    sendEvent(event, { type: 'completed', task });
                    return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
                }
                const error = taskFailure(task);
                sendEvent(event, { type: 'failed', taskId, error });
                return {
                    ok: false,
                    error
                };
            } catch (error) {
                const result = controller.signal.aborted
                    ? failure('aborted', providerErrorMessage('aborted'))
                    : safeFailure(error);
                sendEvent(event, {
                    type: 'failed',
                    taskId,
                    error: result.error
                });
                return result;
            } finally {
                activeTasks.delete(taskId);
            }
        });
    }

    if (selection !== undefined || screenshot !== undefined) {
        ipcMain.handle(translationIpcChannels.cancel, async (event, payload) => {
            if (!isSenderAuthorized(event))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = translationCancelSchema.safeParse(payload);
            if (!parsed.success)
                return failure('invalid-request', 'Translation cancellation request is invalid.');
            const controller = activeTasks.get(parsed.data.taskId);
            if (controller === undefined)
                return failure('invalid-request', 'Translation task was not found.');
            controller.abort();
            return { ok: true } satisfies IpcSaveSuccess;
        });
    }

    return () => {
        ipcMain.removeHandler(providerIpcChannels.save);
        ipcMain.removeHandler(providerIpcChannels.setActive);
        ipcMain.removeHandler(providerIpcChannels.summaries);
        ipcMain.removeHandler(providerIpcChannels.test);
        ipcMain.removeHandler(translationIpcChannels.captureSelection);
        ipcMain.removeHandler(translationIpcChannels.translateSelection);
        ipcMain.removeHandler(screenshotIpcChannels.translate);
        ipcMain.removeHandler(translationIpcChannels.cancel);
        for (const controller of activeTasks.values())
            controller.abort();
        activeTasks.clear();
    };
}
