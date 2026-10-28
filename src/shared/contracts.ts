import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

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

export const capturedImageSchema = z.strictObject({
    dataUrl: z.string().startsWith('data:'),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: positiveInteger,
    height: positiveInteger,
    byteLength: nonNegativeInteger
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

export const performanceModeSchema = z.enum([
    'normal',
    'idle',
    'hidden',
    'battery',
    'paused',
    'fullscreen'
]);

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
export type PerformanceMode = z.infer<typeof performanceModeSchema>;
