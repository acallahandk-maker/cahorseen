import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

export const MAX_CAPTURED_IMAGE_BYTES = 8 * 1024 * 1024;

function decodedBase64ByteLength(payload: string): number | undefined {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
        return undefined;

    const paddingLength = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    if (paddingLength > 0 && payload.length % 4 !== 0)
        return undefined;

    const unpaddedLength = payload.length - paddingLength;
    const remainder = unpaddedLength % 4;
    if (remainder === 1)
        return undefined;

    return Math.floor(unpaddedLength / 4) * 3 + (remainder === 0 ? 0 : remainder - 1);
}

export const mascotStateSchema = z.enum([
    'idle',
    'listening',
    'thinking',
    'success',
    'error',
    'quizzing',
    'happy',
    'sad'
]);

export const mascotEventSchema = z.enum([
    'idle',
    'listening',
    'thinking',
    'success',
    'error',
    'quizzing',
    'happy',
    'sad'
]);

export type MascotState = z.infer<typeof mascotStateSchema>;
export type MascotEvent = z.infer<typeof mascotEventSchema>;

export const providerSummarySchema = z.strictObject({
    id: nonEmptyString,
    name: nonEmptyString,
    baseUrl: z.string().url(),
    hasApiKey: z.boolean(),
    textModel: nonEmptyString,
    visionModel: nonEmptyString
});

export const providerConfigSchema = z.strictObject({
    id: nonEmptyString.optional(),
    name: nonEmptyString,
    baseUrl: z.string().url(),
    apiKey: nonEmptyString,
    textModel: nonEmptyString,
    visionModel: nonEmptyString,
    systemPrompt: z.string().optional(),
    targetLanguage: nonEmptyString.optional(),
    timeoutMs: positiveInteger.optional(),
    streaming: z.boolean().optional()
});

export const translationStatusSchema = z.enum([
    'pending',
    'running',
    'completed',
    'failed'
]);

export const translationTaskSchema = z.strictObject({
    id: nonEmptyString,
    status: translationStatusSchema,
    sourceText: nonEmptyString,
    translatedText: z.string(),
    targetLanguage: nonEmptyString,
    error: z.string().optional()
});

export const memoryEntrySchema = z.strictObject({
    id: nonEmptyString,
    sourceText: nonEmptyString,
    normalizedSource: nonEmptyString,
    translatedText: z.string(),
    sourceLanguage: nonEmptyString,
    targetLanguage: nonEmptyString,
    occurrenceCount: positiveInteger,
    recentOccurrenceCount: nonNegativeInteger,
    translationCount: positiveInteger,
    firstSeenAt: timestamp,
    lastUsedAt: timestamp,
    context: z.string(),
    quizIntervalDays: positiveInteger,
    nextDueAt: timestamp
});

export const quizQuestionSchema = z.strictObject({
    id: nonEmptyString,
    prompt: nonEmptyString,
    contextHint: z.string(),
    options: z.array(nonEmptyString).length(4)
});

export const quizFeedbackSchema = z.strictObject({
    correct: z.boolean(),
    correctOptionIndex: z.number().int().min(0).max(3),
    nextDueAt: timestamp
});

export const connectionTestResultSchema = z.strictObject({
    capability: z.enum(['text', 'vision']),
    success: z.boolean(),
    message: z.string(),
    latencyMs: nonNegativeInteger.optional()
});

export const selectionCaptureSchema = z.strictObject({
    sourceText: nonEmptyString,
    method: z.enum(['accessibility', 'clipboard']),
    clipboardRestored: z.boolean()
});

export const screenBoundsSchema = z.strictObject({
    x: z.number(),
    y: z.number(),
    width: positiveInteger,
    height: positiveInteger
});

const capturedImageBaseSchema = z.strictObject({
    dataUrl: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: positiveInteger,
    height: positiveInteger,
    byteLength: z.number().int().min(1).max(MAX_CAPTURED_IMAGE_BYTES)
});

export const capturedImageSchema = capturedImageBaseSchema.superRefine((image, context) => {
    const expectedPrefix = `data:${image.mimeType};base64,`;
    if (!image.dataUrl.startsWith(expectedPrefix)) {
        context.addIssue({
            code: 'custom',
            message: 'Data URL MIME type must match mimeType',
            path: ['dataUrl']
        });
        return;
    }

    const decodedByteLength = decodedBase64ByteLength(image.dataUrl.slice(expectedPrefix.length));
    if (decodedByteLength === undefined) {
        context.addIssue({
            code: 'custom',
            message: 'Data URL payload must be valid base64',
            path: ['dataUrl']
        });
        return;
    }

    if (decodedByteLength > MAX_CAPTURED_IMAGE_BYTES) {
        context.addIssue({
            code: 'custom',
            message: `Captured image must not exceed ${MAX_CAPTURED_IMAGE_BYTES} bytes`,
            path: ['dataUrl']
        });
    }

    if (decodedByteLength !== image.byteLength) {
        context.addIssue({
            code: 'custom',
            message: 'byteLength must equal the decoded data URL payload length',
            path: ['byteLength']
        });
    }
});

export const mascotHandleSchema = z.strictObject({
    id: nonEmptyString,
    x: z.number(),
    y: z.number(),
    visible: z.boolean()
});

export const heatStatisticSchema = z.strictObject({
    sourceText: nonEmptyString,
    normalizedSource: nonEmptyString,
    translatedText: z.string(),
    sourceLanguage: nonEmptyString,
    targetLanguage: nonEmptyString,
    occurrenceCount: positiveInteger,
    recentOccurrenceCount: nonNegativeInteger,
    lastUsedAt: timestamp
});

const performanceReasonSchema = z.enum([
    'normal',
    'idle',
    'hidden',
    'battery',
    'paused',
    'fullscreen'
]);

const performanceFrameRateSchema = z.union([
    z.literal(30),
    z.literal(10),
    z.literal(0)
]);

const frameRateByReason = {
    normal: 30,
    idle: 10,
    hidden: 10,
    battery: 10,
    paused: 0,
    fullscreen: 0
} as const;

export const performanceModeSchema = z.strictObject({
    reason: performanceReasonSchema,
    frameRate: performanceFrameRateSchema,
    suppressed: z.boolean()
}).refine((mode) => frameRateByReason[mode.reason] === mode.frameRate, {
    message: 'Frame rate must match the performance reason',
    path: ['frameRate']
});

export type ProviderSummary = z.infer<typeof providerSummarySchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type TranslationStatus = z.infer<typeof translationStatusSchema>;
export type TranslationTask = z.infer<typeof translationTaskSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;
export type QuizFeedback = z.infer<typeof quizFeedbackSchema>;
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
export type SelectionCapture = z.infer<typeof selectionCaptureSchema>;
export type ScreenBounds = z.infer<typeof screenBoundsSchema>;
export type CapturedImage = z.infer<typeof capturedImageSchema>;
export type MascotHandle = z.infer<typeof mascotHandleSchema>;
export type HeatStatistic = z.infer<typeof heatStatisticSchema>;
export type PerformanceReason = z.infer<typeof performanceReasonSchema>;
export type PerformanceFrameRate = z.infer<typeof performanceFrameRateSchema>;
export type PerformanceMode = z.infer<typeof performanceModeSchema>;
