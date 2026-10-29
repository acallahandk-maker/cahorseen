import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    translationEventSchema,
    translationIpcChannels,
    translationAckSchema,
    type ProviderConfig,
    type SelectionCapture,
    type TranslationTask
} from '../../src/shared/contracts';
import {
    registerIpcRouter,
    type SelectionIpcService
} from '../../src/main/ipcRouter';
import {
    TranslationWorkerRunner,
    createDeltaEmitter,
    type TranslationRunnerRequest
} from '../../src/main/workers/translationWorker';
import {
    SelectionError,
    SelectionService,
    type SelectionCaptureAdapter
} from '../../src/main/services/selectionService';
import { registerSelectionShortcut } from '../../src/main/selectionShortcut';
import {
    translationBubbleReducer,
    type TranslationBubbleState
} from '../../src/renderer/translation/translationState';

const SYNTHETIC_API_KEY = 'synthetic-api-key-never-logged';
const provider: ProviderConfig = {
    id: 'synthetic-provider',
    name: 'Synthetic Provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: SYNTHETIC_API_KEY,
    textModel: 'synthetic-text-model',
    visionModel: 'synthetic-vision-model',
    targetLanguage: 'zh-CN'
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true
    })));
});

function adapter(overrides: Partial<SelectionCaptureAdapter> = {}): SelectionCaptureAdapter {
    return {
        readAccessibilitySelection: vi.fn(async () => 'selected text'),
        copySelectionToClipboard: vi.fn(async () => undefined),
        readClipboardText: vi.fn(async () => 'clipboard selection'),
        saveClipboard: vi.fn(async () => ({ items: ['original'] })),
        restoreClipboard: vi.fn(async () => undefined),
        ...overrides
    };
}

async function createWorkerScript(source: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-pet-translation-worker-'));
    temporaryDirectories.push(directory);
    const workerPath = join(directory, 'worker.cjs');
    await writeFile(workerPath, source, 'utf8');
    return workerPath;
}

describe('selection translation integration', () => {
    it('runs translation request work in a worker thread and streams deltas', async () => {
        const workerPath = await createWorkerScript(`
            const { parentPort, workerData } = require('node:worker_threads');
            parentPort.postMessage({ type: 'delta', taskId: workerData.taskId, delta: 'ni' });
            parentPort.postMessage({ type: 'delta', taskId: workerData.taskId, delta: 'hao' });
            parentPort.postMessage({
                type: 'completed',
                taskId: workerData.taskId,
                translatedText: '你好',
                model: 'synthetic-text-model'
            });
        `);
        const runner = new TranslationWorkerRunner({ workerPath });
        const request: TranslationRunnerRequest = {
            taskId: 'worker-task',
            provider,
            sourceText: 'hello',
            targetLanguage: 'zh-CN'
        };
        const deltas: string[] = [];

        await expect(runner.run(request, undefined, (delta) => {
            deltas.push(delta);
        })).resolves.toEqual({
            translatedText: '你好',
            model: 'synthetic-text-model'
        });
        expect(deltas).toEqual(['ni', 'hao']);
    });

    it('sanitizes worker failures and never returns the synthetic API key', async () => {
        const workerPath = await createWorkerScript(`
            const { parentPort, workerData } = require('node:worker_threads');
            parentPort.postMessage({
                type: 'failed',
                taskId: workerData.taskId,
                code: 'network',
                message: 'synthetic secret failure ${SYNTHETIC_API_KEY}'
            });
        `);
        const runner = new TranslationWorkerRunner({ workerPath });

        await expect(runner.run({
            taskId: 'failed-task',
            provider,
            sourceText: 'hello',
            targetLanguage: 'zh-CN'
        })).rejects.toMatchObject({
            name: 'ProviderError',
            code: 'network',
            message: 'Provider request failed.'
        });
    });

    it('rejects unknown selection capture payloads at the IPC boundary', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const selection: SelectionIpcService = {
            captureSelectionOnce: vi.fn(async (): Promise<SelectionCapture> => ({
                sourceText: 'selected text',
                method: 'accessibility',
                clipboardRestored: true
            })),
            translateSelection: vi.fn(async (): Promise<TranslationTask> => ({
                id: 'task-1',
                status: 'completed',
                kind: 'selection',
                sourceText: 'selected text',
                translatedText: 'selected text',
                targetLanguage: 'zh-CN'
            }))
        };
        registerIpcRouter({
            ipcMain,
            secureConfig: {
                saveProvider: vi.fn(),
                setActiveProvider: vi.fn(),
                getProviderSummaries: vi.fn(async () => []),
                testProvider: vi.fn()
            },
            selection,
            isSenderAuthorized: () => true
        });

        const result = await handlers.get(translationIpcChannels.captureSelection)?.({}, {
            unexpected: true
        });

        expect(result).toEqual({
            ok: false,
            error: {
                code: 'invalid-request',
                message: 'Selection capture request is invalid.'
            }
        });
        expect(selection.captureSelectionOnce).not.toHaveBeenCalled();
    });

    it('chunks oversized deltas before posting worker messages', () => {
        const messages: string[] = [];
        const emitDelta = createDeltaEmitter((delta) => {
            messages.push(delta);
        });

        emitDelta('a'.repeat(4_501));

        expect(messages).toHaveLength(3);
        expect(messages.every((delta) => delta.length <= 2_000)).toBe(true);
        expect(messages.join('')).toBe('a'.repeat(4_501));
    });

    it('emits terminal failure events after capture starts', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const sends: unknown[] = [];
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const selection = {
            captureSelectionOnce: vi.fn(),
            translateSelection: vi.fn(async (options?: {
                signal?: AbortSignal;
                taskId?: string;
                onTaskId?: (taskId: string) => void;
            }): Promise<TranslationTask> => {
                options?.onTaskId?.(options.taskId ?? 'terminal-failure-task');
                throw new SelectionError('clipboard-restore');
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
            selection,
            isSenderAuthorized: () => true
        });
        const event = {
            sender: {
                send: (_channel: string, payload: unknown) => {
                    sends.push(payload);
                }
            }
        };

        const result = await handlers.get(translationIpcChannels.translateSelection)?.(event, {});

        const failedTask = (result as { value: TranslationTask }).value;
        expect(failedTask).toMatchObject({
            status: 'failed',
            kind: 'selection',
            sourceText: 'Capturing selected text',
            errorCode: 'clipboard-restore'
        });
        const startedTaskId = (sends[0] as { taskId: string }).taskId;
        expect(sends).toEqual([
            { type: 'started', taskId: startedTaskId },
            {
                type: 'failed',
                taskId: failedTask.id,
                error: {
                    code: 'clipboard-restore',
                    message: 'The original clipboard could not be restored.'
                },
                task: failedTask
            }
        ]);
    });

    it('returns a complete failed selection task with exact retry input', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const sends: unknown[] = [];
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const failedTask = {
            id: 'failed-selection-task',
            status: 'failed',
            kind: 'selection',
            sourceText: 'exact failed selection input',
            translatedText: '',
            sourceLanguage: 'en',
            targetLanguage: 'zh-CN',
            providerId: 'synthetic-provider',
            providerName: 'Synthetic Provider',
            textModel: 'synthetic-text-model',
            visionModel: 'synthetic-vision-model',
            translationModel: 'synthetic-text-model',
            error: 'Provider rate limit exceeded.',
            errorCode: 'rate-limited'
        } as unknown as TranslationTask;
        const selection: SelectionIpcService = {
            captureSelectionOnce: vi.fn(),
            translateSelection: vi.fn(async () => failedTask)
        };
        registerIpcRouter({
            ipcMain,
            secureConfig: {
                saveProvider: vi.fn(),
                setActiveProvider: vi.fn(),
                getProviderSummaries: vi.fn(async () => []),
                testProvider: vi.fn()
            },
            selection,
            isSenderAuthorized: () => true
        });
        const event = {
            sender: {
                send: (_channel: string, payload: unknown) => {
                    sends.push(payload);
                }
            }
        };

        const result = await handlers.get(translationIpcChannels.translateSelection)?.(event, {
            sourceText: 'exact failed selection input'
        });

        expect(result).toEqual({ ok: true, value: failedTask });
        expect(sends).toEqual([
            {
                type: 'failed',
                taskId: 'failed-selection-task',
                error: {
                    code: 'rate-limited',
                    message: 'Provider rate limit exceeded.'
                },
                task: failedTask
            }
        ]);
    });

    it('generates distinct main-process task IDs for concurrent starts', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const sends: unknown[] = [];
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const selection = {
            captureSelectionOnce: vi.fn(),
            translateSelection: vi.fn(async (options?: {
                signal?: AbortSignal;
                taskId?: string;
                onTaskId?: (taskId: string) => void;
                onDelta?: (delta: string) => void;
            }): Promise<TranslationTask> => {
                const taskId = options?.taskId ?? 'renderer-collision';
                options?.onTaskId?.(taskId);
                return {
                    id: taskId,
                    status: 'completed',
                    kind: 'selection',
                    sourceText: 'selected text',
                    translatedText: 'ok',
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
            selection,
            isSenderAuthorized: () => true
        });
        const event = {
            sender: {
                send: (_channel: string, payload: unknown) => {
                    sends.push(payload);
                }
            }
        };

        await Promise.all([
            handlers.get(translationIpcChannels.translateSelection)?.(event, {}),
            handlers.get(translationIpcChannels.translateSelection)?.(event, {})
        ]);

        const startedIds = sends
            .filter((payload): payload is { type: 'started'; taskId: string } => (
                typeof payload === 'object'
                && payload !== null
                && (payload as { type?: unknown }).type === 'started'
            ))
            .map((payload) => payload.taskId);
        expect(startedIds).toHaveLength(2);
        expect(new Set(startedIds).size).toBe(2);
    });

    it('registers and disposes the explicit selection shortcut', () => {
        const listeners = new Map<string, () => void>();
        const shortcut = {
            register: vi.fn((accelerator: string, listener: () => void) => {
                listeners.set(accelerator, listener);
                return true;
            }),
            unregister: vi.fn((accelerator: string) => {
                listeners.delete(accelerator);
            })
        };
        const onTrigger = vi.fn();

        const dispose = registerSelectionShortcut({ shortcut, onTrigger });
        listeners.get('CommandOrControl+Shift+T')?.();
        dispose();

        expect(onTrigger).toHaveBeenCalledTimes(1);
        expect(shortcut.unregister).toHaveBeenCalledWith('CommandOrControl+Shift+T');
    });

    it('ignores stale completed and failed terminal events from older translation generations', () => {
        const initialState: TranslationBubbleState = {
            task: {
                id: 'starting',
                status: 'pending',
                kind: 'selection',
                sourceText: 'Selection translation',
                translatedText: '',
                targetLanguage: 'und'
            },
            streamDelta: ''
        };
        const olderState = translationBubbleReducer(initialState, {
            type: 'started',
            taskId: 'older-task'
        });
        const newerState = translationBubbleReducer(olderState, {
            type: 'started',
            taskId: 'newer-task'
        });

        const afterStaleCompleted = translationBubbleReducer(newerState, {
            type: 'completed',
            task: {
                id: 'older-task',
                status: 'completed',
                kind: 'selection',
                sourceText: 'older selection',
                translatedText: 'older translation',
                targetLanguage: 'zh-CN'
            }
        });
        const afterStaleFailed = translationBubbleReducer(afterStaleCompleted, {
            type: 'failed',
            taskId: 'older-task',
            error: {
                code: 'rate-limited',
                message: 'Provider rate limit exceeded.'
            },
            task: {
                id: 'older-task',
                status: 'failed',
                kind: 'selection',
                sourceText: 'older selection',
                translatedText: '',
                targetLanguage: 'zh-CN',
                error: 'Provider rate limit exceeded.',
                errorCode: 'rate-limited'
            }
        });

        expect(afterStaleCompleted).toBe(newerState);
        expect(afterStaleFailed).toBe(newerState);
        expect(afterStaleFailed.task.id).toBe('newer-task');
        expect(afterStaleFailed.task.status).toBe('running');

        const afterNewerCompleted = translationBubbleReducer(afterStaleFailed, {
            type: 'completed',
            task: {
                id: 'newer-task',
                status: 'completed',
                kind: 'selection',
                sourceText: 'newer selection',
                translatedText: 'newer translation',
                targetLanguage: 'zh-CN'
            }
        });
        expect(afterNewerCompleted.task.id).toBe('newer-task');
        expect(afterNewerCompleted.task.status).toBe('completed');
    });

    it('streams typed IPC events and records repeated source text once in one task', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const sends: unknown[] = [];
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const selection: SelectionIpcService = {
            captureSelectionOnce: vi.fn(async (): Promise<SelectionCapture> => ({
                sourceText: 'repeat repeat repeat',
                method: 'accessibility' as const,
                clipboardRestored: true
            })),
            translateSelection: vi.fn(async (options?: {
                signal?: AbortSignal;
                taskId?: string;
                onTaskId?: (taskId: string) => void;
                onDelta?: (delta: string) => void;
            }): Promise<TranslationTask> => {
                const taskId = options?.taskId ?? 'task-1';
                options?.onTaskId?.(taskId);
                options?.onDelta?.('repeated');
                return {
                    id: taskId,
                    status: 'completed',
                    kind: 'selection',
                    sourceText: 'repeat repeat repeat',
                    translatedText: '重复',
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
            selection,
            isSenderAuthorized: () => true
        });
        const event = {
            sender: {
                send: (channel: string, payload: unknown) => {
                    expect(channel).toBe(translationIpcChannels.event);
                    sends.push(translationEventSchema.parse(payload));
                }
            }
        };

        const result = await handlers.get(translationIpcChannels.translateSelection)?.(event, {});
        const startedEvent = sends.find((payload) => (
            typeof payload === 'object'
            && payload !== null
            && (payload as { type?: unknown }).type === 'started'
        )) as { taskId: string };
        const taskId = startedEvent.taskId;

        expect(selection.translateSelection).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            ok: true,
            value: {
                id: taskId,
                status: 'completed',
                kind: 'selection',
                sourceText: 'repeat repeat repeat',
                translatedText: '重复',
                targetLanguage: 'zh-CN'
            }
        });
        expect(sends).toEqual([
            { type: 'started', taskId },
            { type: 'delta', taskId, delta: 'repeated' },
            {
                type: 'completed',
                task: {
                    id: taskId,
                    status: 'completed',
                    kind: 'selection',
                    sourceText: 'repeat repeat repeat',
                    translatedText: '重复',
                    targetLanguage: 'zh-CN'
                }
            }
        ]);
    });

    it('cancels a running selection translation through typed IPC', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain = {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        };
        const selection: SelectionIpcService = {
            captureSelectionOnce: vi.fn(async () => ({
                sourceText: 'selected text',
                method: 'accessibility' as const,
                clipboardRestored: true
            })),
            translateSelection: vi.fn((options?: {
                signal?: AbortSignal;
                taskId?: string;
                onTaskId?: (taskId: string) => void;
            }) => new Promise<TranslationTask>((_resolve, reject) => {
                options?.onTaskId?.(options.taskId ?? 'cancel-task');
                options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
                    once: true
                });
            }))
        };
        registerIpcRouter({
            ipcMain,
            secureConfig: {
                saveProvider: vi.fn(),
                setActiveProvider: vi.fn(),
                getProviderSummaries: vi.fn(async () => []),
                testProvider: vi.fn()
            },
            selection,
            isSenderAuthorized: () => true
        });
        const sends: unknown[] = [];
        const event = {
            sender: {
                send: (_channel: string, payload: unknown) => {
                    sends.push(payload);
                }
            }
        };
        const translationPromise = handlers.get(translationIpcChannels.translateSelection)?.(event, {});
        await vi.waitFor(() => {
            expect(selection.translateSelection).toHaveBeenCalledTimes(1);
        });
        const startedEvent = sends.find((payload) => (
            typeof payload === 'object'
            && payload !== null
            && (payload as { type?: unknown }).type === 'started'
        )) as { taskId: string };

        const cancelResult = await handlers.get(translationIpcChannels.cancel)?.(event, {
            taskId: startedEvent.taskId
        });
        expect(translationAckSchema.parse(cancelResult)).toEqual({ ok: true });

        const cancelledTask = await translationPromise as { value: TranslationTask };
        expect(cancelledTask.value).toMatchObject({
            status: 'failed',
            kind: 'selection',
            errorCode: 'aborted'
        });
        expect(sends).toEqual([
            {
                type: 'started',
                taskId: startedEvent.taskId
            },
            {
                type: 'failed',
                taskId: cancelledTask.value.id,
                error: {
                    code: 'aborted',
                    message: 'Provider request was cancelled.'
                },
                task: cancelledTask.value
            }
        ]);
    });

    it('keeps selection capture and translation failure paths free of secrets', async () => {
        const captureAdapter = adapter({
            readAccessibilitySelection: vi.fn(async () => ''),
            saveClipboard: vi.fn(async () => ({ items: ['original'] })),
            readClipboardText: vi.fn(async () => 'selected text'),
            restoreClipboard: vi.fn(async () => undefined)
        });
        const service = new SelectionService({
            captureAdapter,
            translationRunner: {
                run: vi.fn(async () => {
                    throw new Error(`synthetic ${SYNTHETIC_API_KEY}`);
                })
            },
            getProvider: async () => provider
        });

        const task = await service.translateSelection();

        expect(task.status).toBe('failed');
        expect(task.error).toBe('Provider request failed.');
        expect(JSON.stringify(task)).not.toContain(SYNTHETIC_API_KEY);
        expect(captureAdapter.restoreClipboard).toHaveBeenCalledTimes(1);
    });
});
