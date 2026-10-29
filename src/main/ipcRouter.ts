import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    connectionTestResultSchema,
    providerDetailsSchema,
    providerErrorCodeSchema,
    providerSaveConfigSchema,
    providerDeleteSchema,
    providerSummarySchema,
    screenshotIpcChannels,
    screenshotTranslationStartSchema,
    selectionCaptureStartSchema,
    settingsIpcChannels,
    settingsPreferencesSchema,
    settingsStateSchema,
    detectSourceLanguage,
    translationCancelSchema,
    translationEventSchema,
    translationIpcChannels,
    translationStartSchema,
    type ConnectionTestResult,
    type ProviderDetails,
    type ProviderConfig,
    type ProviderErrorCode,
    type ProviderSaveConfig,
    type ProviderSummary,
    type ScreenBounds,
    type SelectionCapture,
    type SettingsPreferences,
    type SettingsState,
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
    delete: 'desktop-pet:provider-delete',
    setActive: 'desktop-pet:provider-set-active',
    summaries: 'desktop-pet:provider-summaries',
    details: 'desktop-pet:provider-details',
    test: 'desktop-pet:provider-test'
} as const;

export interface ProviderIpcService {
    saveProvider(config: ProviderSaveConfig): Promise<ProviderSummary>;
    deleteProvider?(providerId: string): Promise<void>;
    setActiveProvider(providerId: string): Promise<void>;
    getProviderSummaries(): Promise<ProviderSummary[]>;
    getProviderDetails?(providerId: string): Promise<ProviderDetails>;
    getActiveProviderConfig?(): Promise<ProviderConfig>;
    testProvider(
        providerId: string,
        capability: 'text' | 'vision'
    ): Promise<ConnectionTestResult>;
    getSettings?(): Promise<SettingsState>;
    saveSettings?(preferences: SettingsPreferences): Promise<SettingsState>;
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
    openSettings?: () => void;
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

interface ActiveTaskRecord {
    controller: AbortController;
    event: unknown;
    taskId: string;
    kind: 'selection' | 'screenshot';
    sourceText?: string;
    bounds?: ScreenBounds;
    cancelled: boolean;
    terminalSent: boolean;
    cancelledTask?: TranslationTask;
}

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

export function isProductionRendererUrl(value: unknown): boolean {
    if (typeof value !== 'string')
        return false;
    return value === getProductionRendererFileUrl()
        || value === process.env.ELECTRON_RENDERER_URL;
}

function defaultIsSenderAuthorized(event: unknown): boolean {
    const senderFrame = (event as { senderFrame?: { url?: unknown } }).senderFrame;
    return isProductionRendererUrl(senderFrame?.url);
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

type SafeProviderTaskDetails = Pick<
    TranslationTask,
    'providerId' | 'providerName' | 'textModel' | 'visionModel'
>;

async function activeProviderTaskDetails(
    secureConfig: ProviderIpcService
): Promise<SafeProviderTaskDetails> {
    try {
        const provider = await secureConfig.getActiveProviderConfig?.();
        return {
            ...(provider?.id === undefined ? {} : { providerId: provider.id }),
            ...(provider === undefined ? {} : {
                providerName: provider.name,
                textModel: provider.textModel,
                visionModel: provider.visionModel
            })
        };
    } catch {
        return {};
    }
}

function failedSelectionTask(
    taskId: string,
    sourceText: string,
    error: IpcFailure['error'],
    providerDetails: SafeProviderTaskDetails
): TranslationTask {
    return {
        id: taskId,
        status: 'failed',
        kind: 'selection',
        sourceText,
        translatedText: '',
        sourceLanguage: detectSourceLanguage(sourceText),
        targetLanguage: 'und',
        ...providerDetails,
        error: error.message,
        errorCode: error.code
    };
}

function failedScreenshotTask(
    taskId: string,
    bounds: ScreenBounds,
    error: IpcFailure['error'],
    providerDetails: SafeProviderTaskDetails
): TranslationTask {
    return {
        id: taskId,
        status: 'failed',
        kind: 'screenshot',
        sourceText: 'Screenshot region',
        translatedText: '',
        sourceLanguage: 'und',
        targetLanguage: 'und',
        bounds,
        ...providerDetails,
        error: error.message,
        errorCode: error.code
    };
}

export function registerIpcRouter(options: RegisterIpcRouterOptions): () => void {
    const { ipcMain, secureConfig, selection, screenshot } = options;
    const isSenderAuthorized = options.isSenderAuthorized ?? defaultIsSenderAuthorized;
    const activeTasks = new Map<string, ActiveTaskRecord>();
    const createActiveTask = (
        taskId: string,
        event: unknown,
        kind: ActiveTaskRecord['kind'],
        details?: Pick<ActiveTaskRecord, 'sourceText' | 'bounds'>
    ): ActiveTaskRecord => {
        const record: ActiveTaskRecord = {
            controller: new AbortController(),
            event,
            taskId,
            kind,
            ...details,
            cancelled: false,
            terminalSent: false
        };
        activeTasks.set(taskId, record);
        return record;
    };
    const sendStarted = (record: ActiveTaskRecord): void => {
        if (record.terminalSent)
            return;
        sendEvent(record.event, {
            type: 'started',
            taskId: record.taskId
        });
    };
    const cancelActiveTask = async (record: ActiveTaskRecord): Promise<TranslationTask> => {
        record.cancelled = true;
        record.controller.abort();
        if (record.cancelledTask === undefined) {
            const error = failure('aborted', providerErrorMessage('aborted')).error;
            const providerDetails = await activeProviderTaskDetails(secureConfig);
            record.cancelledTask = record.kind === 'selection'
                ? failedSelectionTask(
                    record.taskId,
                    record.sourceText ?? 'Capturing selected text',
                    error,
                    providerDetails
                )
                : failedScreenshotTask(
                    record.taskId,
                    record.bounds ?? { x: 0, y: 0, width: 1, height: 1 },
                    error,
                    providerDetails
                );
        }
        if (!record.terminalSent) {
            record.terminalSent = true;
            sendEvent(record.event, {
                type: 'failed',
                taskId: record.taskId,
                error: taskFailure(record.cancelledTask),
                task: record.cancelledTask
            });
        }
        return record.cancelledTask;
    };

    ipcMain.handle(providerIpcChannels.save, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = providerSaveConfigSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider configuration is invalid.');

        try {
            validateProviderConfig({
                ...parsed.data,
                apiKey: parsed.data.apiKey ?? 'validation-placeholder'
            });
            const summary = await secureConfig.saveProvider(parsed.data);
            return {
                ok: true,
                value: providerSummarySchema.parse(summary)
            } satisfies IpcSuccess<ProviderSummary>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(providerIpcChannels.delete, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = providerDeleteSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider deletion request is invalid.');

        try {
            if (secureConfig.deleteProvider === undefined)
                return failure('request-failed', 'Provider request failed.');
            await secureConfig.deleteProvider(parsed.data.providerId);
            return { ok: true } satisfies IpcSaveSuccess;
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

    ipcMain.handle(providerIpcChannels.summaries, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');
        if (payload !== undefined && !emptyPayloadSchema.safeParse(payload).success)
            return failure('invalid-request', 'Provider summary request is invalid.');

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

    ipcMain.handle(providerIpcChannels.details, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');
        const parsed = providerDeleteSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider details request is invalid.');
        try {
            if (secureConfig.getProviderDetails === undefined)
                return failure('request-failed', 'Provider request failed.');
            return {
                ok: true,
                value: providerDetailsSchema.parse(
                    await secureConfig.getProviderDetails(parsed.data.providerId)
                )
            } satisfies IpcSuccess<ProviderDetails>;
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

    ipcMain.handle(settingsIpcChannels.get, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');
        if (payload !== undefined && !emptyPayloadSchema.safeParse(payload).success)
            return failure('invalid-request', 'Settings request is invalid.');

        try {
            if (secureConfig.getSettings === undefined)
                return failure('request-failed', 'Provider request failed.');
            return {
                ok: true,
                value: settingsStateSchema.parse(await secureConfig.getSettings())
            } satisfies IpcSuccess<SettingsState>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(settingsIpcChannels.save, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = settingsPreferencesSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Settings preferences are invalid.');

        try {
            if (secureConfig.saveSettings === undefined)
                return failure('request-failed', 'Provider request failed.');
            return {
                ok: true,
                value: settingsStateSchema.parse(
                    await secureConfig.saveSettings(parsed.data)
                )
            } satisfies IpcSuccess<SettingsState>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    if (options.openSettings !== undefined) {
        ipcMain.handle(settingsIpcChannels.open, async (event, payload) => {
            if (!isSenderAuthorized(event))
                return failure('unauthorized', 'IPC sender is not authorized.');
            if (payload !== undefined && !emptyPayloadSchema.safeParse(payload).success)
                return failure('invalid-request', 'Settings open request is invalid.');
            options.openSettings?.();
            return { ok: true } satisfies IpcSaveSuccess;
        });
    }

    if (selection !== undefined) {
        ipcMain.handle(translationIpcChannels.captureSelection, async (event, payload) => {
            if (!isSenderAuthorized(event))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = selectionCaptureStartSchema.safeParse(payload);
            if (!parsed.success)
                return failure('invalid-request', 'Selection capture request is invalid.');
            const { taskId } = parsed.data;
            if (activeTasks.has(taskId))
                return failure('invalid-request', 'Selection translation request is invalid.');
            const record = createActiveTask(taskId, event, 'selection');
            sendStarted(record);
            try {
                const capture = await selection.captureSelectionOnce(record.controller.signal);
                if (record.cancelled || record.controller.signal.aborted)
                    return failure('aborted', providerErrorMessage('aborted'));
                record.sourceText = capture.sourceText;
                return {
                    ok: true,
                    value: capture
                } satisfies IpcSuccess<SelectionCapture>;
            } catch (error) {
                if (record.cancelled || record.controller.signal.aborted)
                    return failure('aborted', providerErrorMessage('aborted'));
                return safeSelectionFailure(error);
            } finally {
                if (record.cancelled || record.sourceText === undefined)
                    activeTasks.delete(taskId);
            }
        });

        ipcMain.handle(translationIpcChannels.translateSelection, async (event, payload) => {
            if (!isSenderAuthorized(event))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = translationStartSchema.safeParse(payload ?? {});
            if (!parsed.success)
                return failure('invalid-request', 'Selection translation request is invalid.');

            const taskId = parsed.data.taskId ?? randomUUID();
            const existing = parsed.data.taskId === undefined
                ? undefined
                : activeTasks.get(taskId);
            if (parsed.data.taskId !== undefined && existing === undefined) {
                const result = failure('aborted', providerErrorMessage('aborted'));
                const task = failedSelectionTask(
                    taskId,
                    parsed.data.sourceText ?? 'Capturing selected text',
                    result.error,
                    await activeProviderTaskDetails(secureConfig)
                );
                return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
            }
            const record = existing ?? createActiveTask(taskId, event, 'selection');
            const controller = record.controller;
            let capturedSourceText = parsed.data.sourceText ?? record.sourceText;
            const onTaskId = (startedTaskId: string): void => {
                if (startedTaskId !== taskId || record.terminalSent)
                    return;
                sendStarted(record);
            };
            try {
                if (record.cancelled)
                    return { ok: true, value: record.cancelledTask ?? await cancelActiveTask(record) };
                const task = await selection.translateSelection({
                    taskId,
                    signal: controller.signal,
                    onTaskId,
                    sourceText: capturedSourceText,
                    onSourceText: (sourceText) => {
                        capturedSourceText = sourceText;
                        record.sourceText = sourceText;
                    },
                    onDelta: (delta) => {
                        if (!record.cancelled && !record.terminalSent) {
                            sendEvent(event, {
                                type: 'delta',
                                taskId,
                                delta
                            });
                        }
                    }
                });
                if (record.cancelled || controller.signal.aborted) {
                    return {
                        ok: true,
                        value: record.cancelledTask ?? await cancelActiveTask(record)
                    };
                }
                if (task.status === 'completed') {
                    record.terminalSent = true;
                    sendEvent(event, { type: 'completed', task });
                    return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
                }
                const error = taskFailure(task);
                record.terminalSent = true;
                sendEvent(event, { type: 'failed', taskId: task.id, error, task });
                return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
            } catch (error) {
                if (record.cancelled || controller.signal.aborted) {
                    return {
                        ok: true,
                        value: record.cancelledTask ?? await cancelActiveTask(record)
                    };
                }
                const result = controller.signal.aborted
                    ? failure('aborted', providerErrorMessage('aborted'))
                    : safeSelectionFailure(error);
                const task = failedSelectionTask(
                    taskId,
                    capturedSourceText ?? 'Capturing selected text',
                    result.error,
                    await activeProviderTaskDetails(secureConfig)
                );
                if (!record.terminalSent) {
                    record.terminalSent = true;
                    sendEvent(event, {
                        type: 'failed',
                        taskId,
                        error: result.error,
                        task
                    });
                }
                return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
            } finally {
                if (activeTasks.get(taskId) === record)
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

            const taskId = randomUUID();
            const record = createActiveTask(taskId, event, 'screenshot', {
                bounds: parsed.data.bounds
            });
            const controller = record.controller;
            const onTaskId = (startedTaskId: string): void => {
                if (startedTaskId === taskId)
                    sendStarted(record);
            };
            try {
                const task = await screenshot.translateScreenshot(parsed.data.bounds, {
                    taskId,
                    signal: controller.signal,
                    onTaskId
                });
                if (record.cancelled || controller.signal.aborted) {
                    return {
                        ok: true,
                        value: record.cancelledTask ?? await cancelActiveTask(record)
                    };
                }
                if (task.status === 'completed') {
                    record.terminalSent = true;
                    sendEvent(event, { type: 'completed', task });
                    return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
                }
                const error = taskFailure(task);
                record.terminalSent = true;
                sendEvent(event, { type: 'failed', taskId: task.id, error, task });
                return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
            } catch (error) {
                if (record.cancelled || controller.signal.aborted) {
                    return {
                        ok: true,
                        value: record.cancelledTask ?? await cancelActiveTask(record)
                    };
                }
                const result = controller.signal.aborted
                    ? failure('aborted', providerErrorMessage('aborted'))
                    : safeFailure(error);
                const task = failedScreenshotTask(
                    taskId,
                    parsed.data.bounds,
                    result.error,
                    await activeProviderTaskDetails(secureConfig)
                );
                if (!record.terminalSent) {
                    record.terminalSent = true;
                    sendEvent(event, {
                        type: 'failed',
                        taskId,
                        error: result.error,
                        task
                    });
                }
                return { ok: true, value: task } satisfies IpcSuccess<TranslationTask>;
            } finally {
                if (activeTasks.get(taskId) === record)
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
            const record = activeTasks.get(parsed.data.taskId);
            if (record === undefined)
                return failure('invalid-request', 'Translation task was not found.');
            await cancelActiveTask(record);
            return { ok: true } satisfies IpcSaveSuccess;
        });
    }

    return () => {
        ipcMain.removeHandler(providerIpcChannels.save);
        ipcMain.removeHandler(providerIpcChannels.delete);
        ipcMain.removeHandler(providerIpcChannels.setActive);
        ipcMain.removeHandler(providerIpcChannels.summaries);
        ipcMain.removeHandler(providerIpcChannels.details);
        ipcMain.removeHandler(providerIpcChannels.test);
        ipcMain.removeHandler(settingsIpcChannels.get);
        ipcMain.removeHandler(settingsIpcChannels.save);
        ipcMain.removeHandler(settingsIpcChannels.open);
        ipcMain.removeHandler(translationIpcChannels.captureSelection);
        ipcMain.removeHandler(translationIpcChannels.translateSelection);
        ipcMain.removeHandler(screenshotIpcChannels.translate);
        ipcMain.removeHandler(translationIpcChannels.cancel);
        for (const record of activeTasks.values())
            record.controller.abort();
        activeTasks.clear();
    };
}
