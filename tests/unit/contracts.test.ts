import { describe, expect, it } from 'vitest';
import {
    MAX_CAPTURED_IMAGE_BYTES,
    capturedImageSchema,
    connectionTestResultSchema,
    heatStatisticSchema,
    memoryEntrySchema,
    performanceModeSchema,
    providerConfigSchema,
    providerSummarySchema,
    quizFeedbackSchema,
    quizQuestionSchema,
    screenBoundsSchema,
    selectionCaptureSchema,
    translationTaskSchema
} from '../../src/shared/contracts';

describe('shared contracts', () => {
    it('rejects provider summaries with missing, unknown, or mistyped fields', () => {
        const valid = {
            id: 'mimo',
            name: 'Mimo',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            hasApiKey: true,
            textModel: 'mimo-text',
            visionModel: 'mimo-vision'
        };

        expect(providerSummarySchema.parse(valid)).toEqual(valid);
        expect(() => providerSummarySchema.parse({ ...valid, hasApiKey: 'yes' })).toThrow();
        expect(() => providerSummarySchema.parse({ ...valid, unknown: true })).toThrow();
        expect(() => providerSummarySchema.omit({ id: true }).parse(valid)).toThrow();
    });

    it('validates provider configuration without allowing unknown fields', () => {
        const valid = {
            name: 'Custom',
            baseUrl: 'https://example.test/v1',
            apiKey: 'secret',
            textModel: 'text-model',
            visionModel: 'vision-model',
            systemPrompt: 'Translate faithfully.',
            targetLanguage: 'en',
            timeoutMs: 30_000,
            streaming: true
        };

        expect(providerConfigSchema.parse(valid)).toEqual(valid);
        expect(() => providerConfigSchema.parse({ ...valid, apiKey: '' })).toThrow();
        expect(() => providerConfigSchema.parse({ ...valid, extra: 'not allowed' })).toThrow();
    });

    it('validates translation, memory, quiz, and result payloads', () => {
        const task = {
            id: 'task-1',
            status: 'completed',
            sourceText: 'hello',
            translatedText: '你好',
            targetLanguage: 'zh-CN'
        };
        const memory = {
            id: 'memory-1',
            sourceText: 'hello',
            normalizedSource: 'hello',
            translatedText: '你好',
            sourceLanguage: 'en',
            targetLanguage: 'zh-CN',
            occurrenceCount: 2,
            recentOccurrenceCount: 1,
            translationCount: 2,
            firstSeenAt: '2026-10-01T00:00:00.000Z',
            lastUsedAt: '2026-10-28T00:00:00.000Z',
            context: 'hello there',
            quizIntervalDays: 3,
            nextDueAt: '2026-10-31T00:00:00.000Z'
        };
        const question = {
            id: 'question-1',
            prompt: 'What does hello mean?',
            contextHint: 'A greeting',
            options: ['你好', '再见', '谢谢', '请']
        };
        const feedback = {
            correct: true,
            correctOptionIndex: 0,
            nextDueAt: '2026-11-03T00:00:00.000Z'
        };

        expect(translationTaskSchema.parse(task)).toEqual(task);
        expect(memoryEntrySchema.parse(memory)).toEqual(memory);
        expect(quizQuestionSchema.parse(question)).toEqual(question);
        expect(quizFeedbackSchema.parse(feedback)).toEqual(feedback);
        expect(() => translationTaskSchema.parse({ ...task, status: 'unknown' })).toThrow();
        expect(() => memoryEntrySchema.parse({ ...memory, occurrenceCount: 0 })).toThrow();
        expect(() => quizQuestionSchema.parse({ ...question, options: ['only one'] })).toThrow();
    });

    it('validates IPC result and capture contracts', () => {
        expect(connectionTestResultSchema.parse({
            capability: 'text',
            success: true,
            message: 'ok',
            latencyMs: 12
        })).toEqual({
            capability: 'text',
            success: true,
            message: 'ok',
            latencyMs: 12
        });
        expect(screenBoundsSchema.parse({ x: 1, y: 2, width: 3, height: 4 })).toEqual({
            x: 1,
            y: 2,
            width: 3,
            height: 4
        });
        expect(selectionCaptureSchema.parse({
            sourceText: 'selected',
            method: 'accessibility',
            clipboardRestored: true
        })).toEqual({
            sourceText: 'selected',
            method: 'accessibility',
            clipboardRestored: true
        });
        expect(capturedImageSchema.parse({
            dataUrl: 'data:image/png;base64,abc',
            mimeType: 'image/png',
            width: 10,
            height: 20,
            byteLength: 2
        })).toEqual({
            dataUrl: 'data:image/png;base64,abc',
            mimeType: 'image/png',
            width: 10,
            height: 20,
            byteLength: 2
        });
        expect(heatStatisticSchema.parse({
            sourceText: 'hello',
            normalizedSource: 'hello',
            translatedText: '你好',
            sourceLanguage: 'en',
            targetLanguage: 'zh-CN',
            occurrenceCount: 2,
            recentOccurrenceCount: 1,
            lastUsedAt: '2026-10-28T00:00:00.000Z'
        })).toBeTruthy();
    });

    it('exports the captured image byte limit', () => {
        expect(MAX_CAPTURED_IMAGE_BYTES).toBe(8 * 1024 * 1024);
    });

    it('rejects inconsistent or oversized captured image payloads', () => {
        const valid = {
            dataUrl: 'data:image/png;base64,abc',
            mimeType: 'image/png',
            width: 10,
            height: 20,
            byteLength: 2
        };
        const oversizedPayload = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
        const invalidImages = [
            {
                ...valid,
                dataUrl: 'data:image/jpeg;base64,abc'
            },
            {
                ...valid,
                byteLength: 3
            },
            {
                ...valid,
                dataUrl: 'data:image/png;base64,%%%'
            },
            {
                ...valid,
                dataUrl: `data:image/png;base64,${oversizedPayload}`,
                byteLength: 8 * 1024 * 1024 + 1
            }
        ];

        expect(invalidImages.map((image) => capturedImageSchema.safeParse(image).success)).toEqual([
            false,
            false,
            false,
            false
        ]);
    });

    it.each([
        { reason: 'normal', frameRate: 30 },
        { reason: 'idle', frameRate: 10 },
        { reason: 'hidden', frameRate: 10 },
        { reason: 'battery', frameRate: 10 },
        { reason: 'paused', frameRate: 0 },
        { reason: 'fullscreen', frameRate: 0 }
    ] as const)('maps $reason to $frameRate FPS', ({ reason, frameRate }) => {
        const invalidFrameRate = frameRate === 30 ? 10 : 30;

        expect(performanceModeSchema.parse({
            reason,
            frameRate,
            suppressed: false
        })).toEqual({
            reason,
            frameRate,
            suppressed: false
        });
        expect(performanceModeSchema.safeParse({
            reason,
            frameRate: invalidFrameRate,
            suppressed: false
        }).success).toBe(false);
    });
});
