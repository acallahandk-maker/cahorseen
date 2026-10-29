import { describe, expect, it, vi } from 'vitest';
import {
    SelectionService,
    type SelectionCaptureAdapter,
    type TranslationRunner
} from '../../src/main/services/selectionService';
import {
    translationBubbleReducer,
    type TranslationBubbleState
} from '../../src/renderer/translation/translationState';
import type { ProviderConfig, TranslationTask } from '../../src/shared/contracts';
import { ProviderError } from '../../src/main/services/openAiClient';

const provider: ProviderConfig = {
    id: 'synthetic-provider',
    name: 'Synthetic Provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'synthetic-api-key',
    textModel: 'synthetic-text-model',
    visionModel: 'synthetic-vision-model',
    targetLanguage: 'zh-CN'
};

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

function runner(result: Partial<TranslationTask> = {}): TranslationRunner {
    return {
        run: vi.fn(async () => ({
            translatedText: '翻译',
            model: 'synthetic-text-model',
            ...result
        }))
    };
}

function service(
    captureAdapter: SelectionCaptureAdapter,
    translationRunner: TranslationRunner,
    createId = () => 'task-1'
): SelectionService {
    return new SelectionService({
        captureAdapter,
        translationRunner,
        getProvider: async () => provider,
        createId
    });
}

describe('selectionService', () => {
    it('prefers accessibility selection without touching the clipboard', async () => {
        const captureAdapter = adapter();
        const result = await service(captureAdapter, runner()).captureSelectionOnce();

        expect(result).toEqual({
            sourceText: 'selected text',
            method: 'accessibility',
            clipboardRestored: true
        });
        expect(captureAdapter.saveClipboard).not.toHaveBeenCalled();
        expect(captureAdapter.copySelectionToClipboard).not.toHaveBeenCalled();
        expect(captureAdapter.readClipboardText).not.toHaveBeenCalled();
        expect(captureAdapter.restoreClipboard).not.toHaveBeenCalled();
    });

    it('falls back to clipboard capture and restores the original clipboard', async () => {
        const snapshot = { items: ['original'] };
        const captureAdapter = adapter({
            readAccessibilitySelection: vi.fn(async () => ''),
            saveClipboard: vi.fn(async () => snapshot),
            readClipboardText: vi.fn(async () => 'clipboard selection'),
            restoreClipboard: vi.fn(async () => undefined)
        });

        const result = await service(captureAdapter, runner()).captureSelectionOnce();

        expect(result).toEqual({
            sourceText: 'clipboard selection',
            method: 'clipboard',
            clipboardRestored: true
        });
        expect(captureAdapter.saveClipboard).toHaveBeenCalledTimes(1);
        expect(captureAdapter.copySelectionToClipboard).toHaveBeenCalledTimes(1);
        expect(captureAdapter.readClipboardText).toHaveBeenCalledTimes(1);
        expect(captureAdapter.restoreClipboard).toHaveBeenCalledWith(snapshot);
    });

    it('rejects an empty selection after restoring clipboard contents', async () => {
        const snapshot = { items: ['original'] };
        const captureAdapter = adapter({
            readAccessibilitySelection: vi.fn(async () => ''),
            saveClipboard: vi.fn(async () => snapshot),
            readClipboardText: vi.fn(async () => ''),
            restoreClipboard: vi.fn(async () => undefined)
        });

        await expect(service(captureAdapter, runner()).captureSelectionOnce()).rejects.toMatchObject({
            name: 'SelectionError',
            code: 'empty-selection'
        });
        expect(captureAdapter.restoreClipboard).toHaveBeenCalledWith(snapshot);
    });

    it('restores clipboard contents when clipboard reading fails', async () => {
        const snapshot = { items: ['original'] };
        const captureAdapter = adapter({
            readAccessibilitySelection: vi.fn(async () => ''),
            saveClipboard: vi.fn(async () => snapshot),
            readClipboardText: vi.fn(async () => {
                throw new Error('synthetic clipboard read failure');
            }),
            restoreClipboard: vi.fn(async () => undefined)
        });

        await expect(service(captureAdapter, runner()).captureSelectionOnce()).rejects.toMatchObject({
            name: 'SelectionError',
            code: 'clipboard-read'
        });
        expect(captureAdapter.restoreClipboard).toHaveBeenCalledWith(snapshot);
    });

    it('restores clipboard contents when fallback capture is cancelled', async () => {
        const snapshot = { items: ['original'] };
        const captureAdapter = adapter({
            readAccessibilitySelection: vi.fn(async () => ''),
            saveClipboard: vi.fn(async () => snapshot),
            copySelectionToClipboard: vi.fn(async () => {
                throw new DOMException('cancelled', 'AbortError');
            }),
            restoreClipboard: vi.fn(async () => undefined)
        });

        await expect(service(captureAdapter, runner()).captureSelectionOnce()).rejects.toMatchObject({
            name: 'SelectionError',
            code: 'aborted'
        });
        expect(captureAdapter.restoreClipboard).toHaveBeenCalledWith(snapshot);
    });

    it('returns a failed task and preserves clipboard contents when translation fails', async () => {
        const snapshot = { items: ['original'] };
        const captureAdapter = adapter({
            readAccessibilitySelection: vi.fn(async () => ''),
            saveClipboard: vi.fn(async () => snapshot),
            readClipboardText: vi.fn(async () => 'selected text'),
            restoreClipboard: vi.fn(async () => undefined)
        });
        const translationRunner: TranslationRunner = {
            run: vi.fn(async () => {
                throw new Error(`synthetic failure for ${provider.apiKey}`);
            })
        };

        const result = await service(captureAdapter, translationRunner).translateSelection();

        expect(result).toEqual({
            id: 'task-1',
            status: 'failed',
            kind: 'selection',
            sourceText: 'selected text',
            translatedText: '',
            sourceLanguage: 'en',
            targetLanguage: 'zh-CN',
            providerId: 'synthetic-provider',
            providerName: 'Synthetic Provider',
            textModel: 'synthetic-text-model',
            visionModel: 'synthetic-vision-model',
            error: 'Provider request failed.',
            errorCode: 'request-failed'
        });
        expect(captureAdapter.restoreClipboard).toHaveBeenCalledWith(snapshot);
        expect(JSON.stringify(result)).not.toContain(provider.apiKey);
    });

    it('returns a valid failed task when the provider target language is missing', async () => {
        const captureAdapter = adapter();
        const translationRunner = runner();
        const testService = new SelectionService({
            captureAdapter,
            translationRunner,
            getProvider: async () => ({
                ...provider,
                targetLanguage: undefined
            }),
            createId: () => 'task-language'
        });

        const result = await testService.translateSelection();

        expect(result).toEqual({
            id: 'task-language',
            status: 'failed',
            kind: 'selection',
            sourceText: 'selected text',
            translatedText: '',
            sourceLanguage: 'en',
            targetLanguage: 'und',
            providerId: 'synthetic-provider',
            providerName: 'Synthetic Provider',
            textModel: 'synthetic-text-model',
            visionModel: 'synthetic-vision-model',
            error: 'Provider configuration is invalid.',
            errorCode: 'invalid-config'
        });
        expect(translationRunner.run).not.toHaveBeenCalled();
    });

    it('preserves provider error codes on failed translation tasks', async () => {
        const captureAdapter = adapter();
        const translationRunner: TranslationRunner = {
            run: vi.fn(async () => {
                throw new ProviderError('rate-limited');
            })
        };

        const result = await service(captureAdapter, translationRunner).translateSelection();

        expect(result.errorCode).toBe('rate-limited');
        expect(result.error).toBe('Provider rate limit exceeded.');
    });

    it('reduces typed lifecycle events into bubble state', () => {
        const initial: TranslationBubbleState = {
            task: {
                id: 'task-bubble',
                status: 'running',
                kind: 'selection',
                sourceText: 'Capturing selected text',
                translatedText: '',
                targetLanguage: 'und'
            },
            streamDelta: ''
        };

        const running = translationBubbleReducer(initial, {
            type: 'delta',
            taskId: 'task-bubble',
            delta: 'hello'
        });
        const completed = translationBubbleReducer(running, {
            type: 'completed',
            task: {
                id: 'task-bubble',
                status: 'completed',
                kind: 'selection',
                sourceText: 'hello',
                translatedText: '你好',
                targetLanguage: 'zh-CN'
            }
        });

        expect(running.streamDelta).toBe('hello');
        expect(completed.task.status).toBe('completed');
        expect(completed.task.translatedText).toBe('你好');
    });

    it('counts repeated source text once within one translation task', async () => {
        const captureAdapter = adapter();
        const translationRunner = runner();

        const result = await service(captureAdapter, translationRunner).translateSelection();

        expect(translationRunner.run).toHaveBeenCalledTimes(1);
        expect(translationRunner.run).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: expect.objectContaining({ streaming: true })
            }),
            undefined,
            undefined
        );
        expect(result.sourceText).toBe('selected text');
        expect(result.status).toBe('completed');
        expect(result).toMatchObject({
            sourceLanguage: 'en',
            targetLanguage: 'zh-CN',
            providerId: 'synthetic-provider',
            providerName: 'Synthetic Provider',
            textModel: 'synthetic-text-model',
            visionModel: 'synthetic-vision-model',
            translationModel: 'synthetic-text-model'
        });
    });

    it('reuses retry source text without recapturing selection', async () => {
        const captureAdapter = adapter();
        const translationRunner = runner();

        const result = await service(captureAdapter, translationRunner).translateSelection({
            sourceText: 'exact retry source'
        });

        expect(result.sourceText).toBe('exact retry source');
        expect(captureAdapter.readAccessibilitySelection).not.toHaveBeenCalled();
        expect(captureAdapter.copySelectionToClipboard).not.toHaveBeenCalled();
        expect(captureAdapter.readClipboardText).not.toHaveBeenCalled();
        expect(translationRunner.run).toHaveBeenCalledWith(
            expect.objectContaining({ sourceText: 'exact retry source' }),
            undefined,
            undefined
        );
    });
});
