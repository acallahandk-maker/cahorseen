import { describe, expect, it, vi } from 'vitest';
import {
    MemoryDatabaseError
} from '../../src/main/services/memoryDatabase';
import {
    OpenAiClient,
    type TranslationResult
} from '../../src/main/services/openAiClient';
import {
    ScreenshotService,
    type ImageTranslationRunner
} from '../../src/main/services/screenshotService';
import {
    SelectionService,
    type SelectionCaptureAdapter
} from '../../src/main/services/selectionService';
import {
    validateVocabularySourceText,
    VocabularyTextValidationError
} from '../../src/shared/vocabularyText';
import {
    capturedImageSchema,
    type CapturedImage,
    type ProviderConfig,
    type ScreenBounds,
    type TranslationTask
} from '../../src/shared/contracts';

const provider: ProviderConfig = {
    id: 'synthetic-provider',
    name: 'Synthetic Provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'placeholder-safe-credential',
    textModel: 'synthetic-text-model',
    visionModel: 'synthetic-vision-model',
    targetLanguage: 'fr-FR'
};

const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY1BYte8/AAT+AogiBwaJAAAAAElFTkSuQmCC',
    'base64'
);

function imageRunner(sourceText: string): ImageTranslationRunner {
    const client = new OpenAiClient({
        fetchImpl: async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as {
                messages: Array<{
                    content: Array<{ type: string; image_url?: { url: string } }> | string;
                }>;
            };
            const imagePart = body.messages
                .flatMap((message) => Array.isArray(message.content) ? message.content : [])
                .find((part) => part.type === 'image_url');
            expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,/u);
            return new Response(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            sourceText,
                            translatedText: 'Traduit'
                        })
                    }
                }]
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    return {
        runImage: async (request): Promise<TranslationResult> => client.translateImage({
            provider: request.provider,
            image: request.image,
            context: request.context,
            targetLanguage: request.targetLanguage,
            structuredResponse: true
        })
    };
}

function screenshotService(
    runner: ImageTranslationRunner,
    recordTranslation: (task: TranslationTask) => Promise<void>
): ScreenshotService {
    return new ScreenshotService({
        captureAdapter: {
            captureClippedRegion: async () => ({
                data: Buffer.from(tinyPng),
                mimeType: 'image/png',
                width: 1,
                height: 1
            })
        },
        translationRunner: runner,
        getProvider: async () => provider,
        getDisplays: () => [{ x: 0, y: 0, width: 100, height: 100 }],
        mapBoundsToCapturePixels: (_displayIndex, bounds) => bounds,
        recordTranslation
    });
}

function memoryRecorder(): (task: TranslationTask) => Promise<void> {
    return async (task) => {
        try {
            validateVocabularySourceText(task.sourceText);
        } catch (error) {
            if (error instanceof VocabularyTextValidationError)
                throw new MemoryDatabaseError('invalid-request', error.message);
            throw error;
        }
    };
}

function selectionAdapter(): SelectionCaptureAdapter {
    return {
        readAccessibilitySelection: async () => 'Hello',
        copySelectionToClipboard: async () => undefined,
        readClipboardText: async () => 'Hello',
        saveClipboard: async () => 'original',
        restoreClipboard: async () => undefined
    };
}

describe('final review translation privacy boundaries', () => {
    it.each([
        ['literal screenshot sentence', 'Screenshot region contains a blue sign'],
        [
            'uniform-width natural-language token sequence',
            'alpha bravo charlie delta echo foxtrot golf hotel'
        ]
    ])('keeps %s as a completed screenshot translation', async (_name, sourceText) => {
        const recordTranslation = vi.fn(memoryRecorder());
        const service = screenshotService(imageRunner(sourceText), recordTranslation);

        const result = await service.translateScreenshot({
            x: 1,
            y: 2,
            width: 10,
            height: 10
        }, { targetLanguage: 'fr-FR' });

        expect(result.status).toBe('completed');
        expect(result.translatedText).toBe('Traduit');
        expect(result.memoryStatus).toMatchObject({ state: 'recorded' });
        expect(recordTranslation).toHaveBeenCalledWith(expect.objectContaining({
            sourceText
        }));
    });

    it('preserves the translation when persistence rejects the source text', async () => {
        const sourceText = 'data:image/png;base64,AAAA';
        const recordTranslation = vi.fn(memoryRecorder());
        const service = screenshotService(imageRunner(sourceText), recordTranslation);

        const result = await service.translateScreenshot({
            x: 1,
            y: 2,
            width: 10,
            height: 10
        }, { targetLanguage: 'fr-FR' });

        expect(result.status).toBe('completed');
        expect(result.translatedText).toBe('Traduit');
        expect(result.memoryStatus).toMatchObject({
            state: 'failed',
            code: 'invalid-request'
        });
    });

    it('uses a MIME-consistent decodable PNG for screenshot capture fixtures', async () => {
        const image: CapturedImage = {
            dataUrl: `data:image/png;base64,${tinyPng.toString('base64')}`,
            mimeType: 'image/png',
            width: 1,
            height: 1,
            byteLength: tinyPng.byteLength
        };
        expect(capturedImageSchema.parse(image)).toEqual(image);
        expect(tinyPng.subarray(0, 8)).toEqual(Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
        ]));
    });

    it.each([
        ['selection', 'selection'],
        ['screenshot', 'screenshot']
    ])('gates %s memory retention with translation-history settings', async (_name, kind) => {
        const recordTranslation = vi.fn(async () => undefined);
        const service = kind === 'selection'
            ? new SelectionService({
                captureAdapter: selectionAdapter(),
                translationRunner: {
                    run: async () => ({
                        translatedText: 'Traduit',
                        model: 'text-model'
                    })
                },
                getProvider: async () => provider,
                recordTranslation,
                isTranslationHistoryEnabled: async () => false
            } as never)
            : new ScreenshotService({
                captureAdapter: {
                    captureClippedRegion: async () => ({
                        data: Buffer.from(tinyPng),
                        mimeType: 'image/png',
                        width: 1,
                        height: 1
                    })
                },
                translationRunner: {
                    runImage: async () => ({
                        sourceText: 'Hello',
                        translatedText: 'Traduit',
                        model: 'vision-model'
                    })
                },
                getProvider: async () => provider,
                getDisplays: () => [{ x: 0, y: 0, width: 100, height: 100 }],
                mapBoundsToCapturePixels: (
                    _displayIndex: number,
                    bounds: ScreenBounds
                ) => bounds,
                recordTranslation,
                isTranslationHistoryEnabled: async () => false
            } as never);

        const result = kind === 'selection'
            ? await (service as SelectionService).translateSelection({
                sourceText: 'Hello',
                targetLanguage: 'fr-FR'
            })
            : await (service as ScreenshotService).translateScreenshot({
                x: 1,
                y: 2,
                width: 10,
                height: 10
            }, { targetLanguage: 'fr-FR' });

        expect(result.status).toBe('completed');
        expect(result.memoryStatus).toBeUndefined();
        expect(recordTranslation).not.toHaveBeenCalled();
    });
});
