import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    MemoryDatabaseError
} from '../../src/main/services/memoryDatabase';
import {
    SelectionService,
    type SelectionCaptureAdapter,
    type TranslationRunner
} from '../../src/main/services/selectionService';
import {
    ScreenshotService,
    type ScreenshotCaptureAdapter
} from '../../src/main/services/screenshotService';
import {
    TranslationWorkerRunner,
    type TranslationRunnerRequest
} from '../../src/main/workers/translationWorker';
import {
    ProviderError,
    type TranslationResult
} from '../../src/main/services/openAiClient';
import type {
    MemoryPersistenceStatus,
    ProviderConfig
} from '../../src/shared/contracts';

const provider: ProviderConfig = {
    id: 'synthetic-provider',
    name: 'Synthetic Provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'sk-synthetic-test-only',
    textModel: 'text-model',
    visionModel: 'vision-model',
    targetLanguage: 'fr-FR'
};

function selectionAdapter(): SelectionCaptureAdapter {
    return {
        readAccessibilitySelection: async () => 'Hello',
        copySelectionToClipboard: async () => undefined,
        readClipboardText: async () => 'Hello',
        saveClipboard: async () => ({ items: ['original'] }),
        restoreClipboard: async () => undefined
    };
}

function screenshotAdapter(): ScreenshotCaptureAdapter {
    return {
        captureClippedRegion: async () => ({
            data: Buffer.from('synthetic-image'),
            mimeType: 'image/jpeg',
            width: 2,
            height: 2
        })
    };
}

describe('production memory recording', () => {
    it('records completed selection tasks and does not record failed or cancelled tasks', async () => {
        const recordTranslation = vi.fn(async () => undefined);
        const successfulRunner: TranslationRunner = {
            run: async (): Promise<TranslationResult> => ({
                translatedText: 'Bonjour',
                model: 'text-model'
            })
        };
        const successfulService = new SelectionService({
            captureAdapter: selectionAdapter(),
            translationRunner: successfulRunner,
            getProvider: async () => provider,
            recordTranslation
        });
        const completed = await successfulService.translateSelection({
            sourceText: 'Hello',
            targetLanguage: 'fr-FR'
        });
        expect(completed.status).toBe('completed');
        expect(recordTranslation).toHaveBeenCalledExactlyOnceWith(completed);

        const failedRunner: TranslationRunner = {
            run: async () => {
                throw new ProviderError('network');
            }
        };
        const failedService = new SelectionService({
            captureAdapter: selectionAdapter(),
            translationRunner: failedRunner,
            getProvider: async () => provider,
            recordTranslation
        });
        const failed = await failedService.translateSelection({
            sourceText: 'Hello',
            targetLanguage: 'fr-FR'
        });
        expect(failed.status).toBe('failed');

        const cancelled = await failedService.translateSelection({
            sourceText: 'Hello',
            targetLanguage: 'fr-FR',
            signal: AbortSignal.abort()
        });
        expect(cancelled.status).toBe('failed');
        expect(recordTranslation).toHaveBeenCalledTimes(1);
    });

    it('records completed screenshot vision translations but not failed or cancelled captures', async () => {
        const recordTranslation = vi.fn(async () => undefined);
        const successfulRunner = {
            runImage: async (): Promise<TranslationResult> => ({
                sourceText: 'Bonjour le monde',
                translatedText: 'Traduit',
                model: 'vision-model'
            })
        };
        const successfulService = new ScreenshotService({
            captureAdapter: screenshotAdapter(),
            translationRunner: successfulRunner,
            getProvider: async () => provider,
            getDisplays: () => [{ x: 0, y: 0, width: 100, height: 100 }],
            mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
            recordTranslation
        });
        const completed = await successfulService.translateScreenshot({
            x: 1,
            y: 2,
            width: 10,
            height: 10
        }, {
            targetLanguage: 'fr-FR'
        });
        expect(completed.status).toBe('completed');
        expect(completed.kind).toBe('screenshot');
        expect(recordTranslation).toHaveBeenCalledExactlyOnceWith({
            ...completed,
            sourceText: 'Bonjour le monde'
        });

        const failedService = new ScreenshotService({
            captureAdapter: screenshotAdapter(),
            translationRunner: {
                runImage: async () => {
                    throw new ProviderError('network');
                }
            },
            getProvider: async () => provider,
            getDisplays: () => [{ x: 0, y: 0, width: 100, height: 100 }],
            mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
            recordTranslation
        });
        const failed = await failedService.translateScreenshot({
            x: 1,
            y: 2,
            width: 10,
            height: 10
        });
        expect(failed.status).toBe('failed');
        const cancelled = await failedService.translateScreenshot({
            x: 1,
            y: 2,
            width: 10,
            height: 10
        }, {
            signal: AbortSignal.abort()
        });
        expect(cancelled.status).toBe('failed');
        expect(recordTranslation).toHaveBeenCalledTimes(1);
    });

    it('never records placeholder screenshot sources when vision output lacks source text', async () => {
        const recordTranslation = vi.fn(async () => undefined);
        const service = new ScreenshotService({
            captureAdapter: screenshotAdapter(),
            translationRunner: {
                runImage: async (): Promise<TranslationResult> => ({
                    translatedText: 'Traduit',
                    model: 'vision-model'
                })
            },
            getProvider: async () => provider,
            getDisplays: () => [{ x: 0, y: 0, width: 100, height: 100 }],
            mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
            recordTranslation
        });

        const completed = await service.translateScreenshot({
            x: 1,
            y: 2,
            width: 10,
            height: 10
        }, {
            targetLanguage: 'fr-FR'
        });

        expect(completed.status).toBe('completed');
        expect(completed.sourceText).toBe('Screenshot region');
        expect(completed.memoryStatus).toMatchObject({
            state: 'failed',
            code: 'invalid-request',
            recoverable: true
        });
        expect(recordTranslation).not.toHaveBeenCalled();
    });

    it.each([
        ['data URL', 'data:image/png;base64,AAAA'],
        ['base64 payload', 'QmFzZTY0UGF5bG9hZEJhc2U2NFBheWxvYWRCYXNlNjRQYXlsb2FkQmFzZTY0UGF5bG9hZA=='],
        ['capture placeholder', 'Screenshot region']
    ])('rejects %s at the recording boundary', async (_kind, sourceText) => {
        const recordTranslation = vi.fn(async () => undefined);
        const service = new ScreenshotService({
            captureAdapter: screenshotAdapter(),
            translationRunner: {
                runImage: async (): Promise<TranslationResult> => ({
                    sourceText,
                    translatedText: 'Traduit',
                    model: 'vision-model'
                })
            },
            getProvider: async () => provider,
            getDisplays: () => [{ x: 0, y: 0, width: 100, height: 100 }],
            mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
            recordTranslation
        });

        const completed = await service.translateScreenshot({
            x: 1,
            y: 2,
            width: 10,
            height: 10
        }, {
            targetLanguage: 'fr-FR'
        });

        expect(completed.status).toBe('completed');
        expect(completed.memoryStatus).toMatchObject({
            state: 'failed',
            code: 'invalid-request',
            recoverable: true
        });
        expect(recordTranslation).not.toHaveBeenCalled();
    });

    it('reports nonfatal memory persistence errors without failing translation', async () => {
        const statuses: MemoryPersistenceStatus[] = [];
        const service = new SelectionService({
            captureAdapter: selectionAdapter(),
            translationRunner: {
                run: async () => ({ translatedText: 'Bonjour', model: 'text-model' })
            },
            getProvider: async () => provider,
            recordTranslation: async () => {
                throw new MemoryDatabaseError('timeout', 'Memory timed out.');
            },
            onMemoryStatus: (status) => statuses.push(status)
        });

        const task = await service.translateSelection({
            sourceText: 'Hello',
            targetLanguage: 'fr-FR'
        });
        expect(task.status).toBe('completed');
        expect(task.memoryStatus).toMatchObject({
            state: 'failed',
            code: 'timeout',
            recoverable: true
        });
        expect(statuses).toEqual([task.memoryStatus]);
    });

    it('surfaces translation-worker completion-hook failures as nonfatal typed status', async () => {
        const worker = new EventEmitter() as EventEmitter & {
            terminate: ReturnType<typeof vi.fn>;
            postMessage: ReturnType<typeof vi.fn>;
        };
        worker.terminate = vi.fn();
        worker.postMessage = vi.fn(() => undefined);
        const workerFactory = vi.fn(() => {
            queueMicrotask(() => worker.emit('message', {
                type: 'completed',
                taskId: 'memory-hook-task',
                translatedText: 'Bonjour',
                model: 'text-model'
            }));
            return worker;
        });
        const statuses: MemoryPersistenceStatus[] = [];
        const runner = new TranslationWorkerRunner({
            workerPath: 'translationWorker.js',
            workerFactory: workerFactory as never,
            onTaskCompleted: async () => {
                throw new MemoryDatabaseError('worker', 'Memory worker stopped.');
            },
            onMemoryStatus: (status) => statuses.push(status)
        });
        const request: TranslationRunnerRequest = {
            taskId: 'memory-hook-task',
            provider,
            sourceText: 'Hello',
            targetLanguage: 'fr-FR'
        };

        await expect(runner.run(request)).resolves.toMatchObject({
            translatedText: 'Bonjour',
            model: 'text-model',
            memoryStatus: {
                state: 'failed',
                code: 'worker',
                recoverable: true
            }
        });
        expect(statuses).toMatchObject([{
            state: 'failed',
            code: 'worker',
            recoverable: true
        }]);
    });
});
