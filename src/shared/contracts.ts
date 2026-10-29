import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

export const MAX_CAPTURED_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_TEXT_CHARS = 32_000;
export const MAX_CONTEXT_CHARS = 16_000;
export const MAX_SYSTEM_PROMPT_CHARS = 4_000;
export const MAX_TARGET_LANGUAGE_CHARS = 64;
export const MAX_TRANSLATED_TEXT_CHARS = 16_000;
export const MAX_TRANSLATION_DELTA_CHARS = 2_000;

function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

export function isValidHotkey(value: string): boolean {
    const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2)
        return false;
    const modifiers = parts.slice(0, -1);
    const key = parts.at(-1);
    const allowedModifiers = ['Alt', 'Ctrl', 'Meta', 'Shift'];
    const modifierAliases = ['Alt', 'Control', 'Meta', 'OS', 'Shift'];
    return key !== undefined
        && !modifierAliases.includes(key)
        && modifiers.every((modifier) => allowedModifiers.includes(modifier))
        && new Set(modifiers).size === modifiers.length;
}

export function detectSourceLanguage(value: string): string {
    if (/[\u3040-\u30ff]/u.test(value))
        return 'ja';
    if (/[\uac00-\ud7af]/u.test(value))
        return 'ko';
    if (/[\u4e00-\u9fff]/u.test(value))
        return 'zh';
    if (/[\u0400-\u04ff]/u.test(value))
        return 'ru';
    if (/[\u0600-\u06ff]/u.test(value))
        return 'ar';
    if (/[\u0590-\u05ff]/u.test(value))
        return 'he';
    if (/[\u0900-\u097f]/u.test(value))
        return 'hi';
    const normalized = value.trim().toLowerCase();
    const englishMarkers = new Set([
        'a', 'an', 'and', 'hello', 'i', 'is', 'of', 'the', 'this', 'to', 'you'
    ]);
    const words = normalized.split(/\s+/u);
    if (words.some((word) => englishMarkers.has(word)))
        return 'en';
    return /^\p{ASCII}+$/u.test(value) && /[A-Za-z]/u.test(value) ? 'en' : 'und';
}

const httpsUrl = z.string().url().refine(isHttpsUrl, {
    message: 'Base URL must use HTTPS'
});

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
    baseUrl: httpsUrl,
    hasApiKey: z.boolean(),
    textModel: nonEmptyString,
    visionModel: nonEmptyString
});

export const providerConfigSchema = z.strictObject({
    id: nonEmptyString.optional(),
    name: nonEmptyString,
    baseUrl: httpsUrl,
    apiKey: nonEmptyString,
    textModel: nonEmptyString,
    visionModel: nonEmptyString,
    systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).optional(),
    targetLanguage: nonEmptyString.max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    timeoutMs: positiveInteger.optional(),
    streaming: z.boolean().optional()
});

export const providerSaveConfigSchema = providerConfigSchema
    .omit({ apiKey: true })
    .extend({
        apiKey: z.string().min(1).optional()
    });

export const providerDetailsSchema = providerConfigSchema
    .omit({ apiKey: true })
    .extend({ id: nonEmptyString });

export const providerDeleteSchema = z.strictObject({
    providerId: nonEmptyString
});

export const translationStatusSchema = z.enum([
    'pending',
    'running',
    'completed',
    'failed'
]);

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

export const memoryPersistenceStatusSchema = z.strictObject({
    state: z.enum(['recorded', 'failed']),
    code: z.enum([
        'busy',
        'conflict',
        'internal',
        'invalid-request',
        'not-found',
        'storage',
        'timeout',
        'worker'
    ]).optional(),
    recoverable: z.literal(true),
    message: z.string().min(1).max(500)
}).superRefine((status, context) => {
    if (status.state === 'recorded' && status.code !== undefined) {
        context.addIssue({
            code: 'custom',
            path: ['code'],
            message: 'Successful memory status must not include an error code.'
        });
    }
    if (status.state === 'failed' && status.code === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['code'],
            message: 'Failed memory status requires an error code.'
        });
    }
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

export const providerErrorCodeSchema = z.enum([
    'invalid-config',
    'invalid-request',
    'invalid-response',
    'authentication',
    'rate-limited',
    'timeout',
    'aborted',
    'network',
    'server',
    'invalid-storage',
    'provider-not-found',
    'storage-unavailable',
    'storage-error'
]);

const connectionTestCapabilitySchema = z.enum(['text', 'vision']);
export const connectionTestResultSchema = z.discriminatedUnion('success', [
    z.strictObject({
        capability: connectionTestCapabilitySchema,
        success: z.literal(true),
        message: z.string(),
        latencyMs: nonNegativeInteger.optional()
    }),
    z.strictObject({
        capability: connectionTestCapabilitySchema,
        success: z.literal(false),
        message: z.string(),
        errorCode: providerErrorCodeSchema,
        latencyMs: nonNegativeInteger.optional()
    })
]);

export const selectionErrorCodeSchema = z.enum([
    'empty-selection',
    'clipboard-read',
    'clipboard-restore',
    'invalid-selection'
]);

export const translationErrorCodeSchema = z.union([
    providerErrorCodeSchema,
    selectionErrorCodeSchema,
    z.enum([
        'unauthorized',
        'invalid-request',
        'request-failed',
        'unsupported-vision'
    ])
]);

export const translationErrorSchema = z.strictObject({
    code: translationErrorCodeSchema,
    message: z.string().max(500)
});

export const screenBoundsSchema = z.strictObject({
    x: z.number().int(),
    y: z.number().int(),
    width: positiveInteger,
    height: positiveInteger
});

export const translationRetryInputSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('selection'),
        strategy: z.literal('reuse-source'),
        sourceText: z.string().min(1).max(MAX_SOURCE_TEXT_CHARS)
    }),
    z.strictObject({
        kind: z.literal('selection-capture'),
        strategy: z.literal('recapture')
    }),
    z.strictObject({
        kind: z.literal('screenshot'),
        strategy: z.literal('recapture'),
        bounds: screenBoundsSchema
    })
]);

export const translationTaskSchema = z.strictObject({
    id: nonEmptyString,
    status: translationStatusSchema,
    kind: z.enum(['selection', 'screenshot']),
    sourceText: nonEmptyString,
    translatedText: z.string(),
    sourceLanguage: nonEmptyString.max(64).optional(),
    targetLanguage: nonEmptyString,
    bounds: screenBoundsSchema.optional(),
    providerId: nonEmptyString.optional(),
    providerName: nonEmptyString.optional(),
    textModel: nonEmptyString.optional(),
    visionModel: nonEmptyString.optional(),
    translationModel: nonEmptyString.optional(),
    error: z.string().optional(),
    errorCode: translationErrorCodeSchema.optional(),
    memoryStatus: memoryPersistenceStatusSchema.optional(),
    retryInput: translationRetryInputSchema
}).superRefine((task, context) => {
    if (task.kind === 'screenshot' && task.bounds === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['bounds'],
            message: 'Screenshot tasks must preserve capture bounds'
        });
    }
    if (task.kind === 'selection' && task.bounds !== undefined) {
        context.addIssue({
            code: 'custom',
            path: ['bounds'],
            message: 'Selection tasks must not retain capture bounds'
        });
    }
    if (task.kind === 'selection' && task.retryInput.kind === 'screenshot') {
        context.addIssue({
            code: 'custom',
            path: ['retryInput'],
            message: 'Selection tasks must use selection retry input'
        });
    }
    if (
        task.kind === 'selection'
        && task.retryInput.kind === 'selection'
        && task.retryInput.sourceText !== task.sourceText
    ) {
        context.addIssue({
            code: 'custom',
            path: ['retryInput', 'sourceText'],
            message: 'Selection retry source must match the task source'
        });
    }
    if (task.kind === 'screenshot' && task.retryInput.kind !== 'screenshot') {
        context.addIssue({
            code: 'custom',
            path: ['retryInput'],
            message: 'Screenshot tasks must use screenshot retry input'
        });
    }
    if (
        task.kind === 'screenshot'
        && task.retryInput.kind === 'screenshot'
        && (
            task.bounds === undefined
            || task.retryInput.bounds.x !== task.bounds.x
            || task.retryInput.bounds.y !== task.bounds.y
            || task.retryInput.bounds.width !== task.bounds.width
            || task.retryInput.bounds.height !== task.bounds.height
        )
    ) {
        context.addIssue({
            code: 'custom',
            path: ['retryInput', 'bounds'],
            message: 'Screenshot retry bounds must match the task bounds'
        });
    }
});

export const translationAckSchema = z.union([
    z.strictObject({
        ok: z.literal(true)
    }),
    z.strictObject({
        ok: z.literal(false),
        error: translationErrorSchema
    })
]);

export const translationEventSchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('started'),
        taskId: nonEmptyString
    }),
    z.strictObject({
        type: z.literal('delta'),
        taskId: nonEmptyString,
        delta: z.string().max(MAX_TRANSLATION_DELTA_CHARS)
    }),
    z.strictObject({
        type: z.literal('completed'),
        task: translationTaskSchema
    }),
    z.strictObject({
        type: z.literal('failed'),
        taskId: nonEmptyString,
        error: translationErrorSchema,
        task: translationTaskSchema
    })
]);

export const translationStartSchema = z.strictObject({
    taskId: z.string().min(1).max(128).optional(),
    sourceText: z.string().min(1).max(MAX_SOURCE_TEXT_CHARS).optional()
});

export const translationCancelSchema = z.strictObject({
    taskId: z.string().min(1).max(128)
});

export const translationIpcChannels = {
    captureSelection: 'desktop-pet:selection-capture',
    translateSelection: 'desktop-pet:selection-translate',
    cancel: 'desktop-pet:translation-cancel',
    event: 'desktop-pet:translation-event',
    selectionShortcut: 'desktop-pet:selection-shortcut'
} as const;

export const settingsIpcChannels = {
    get: 'desktop-pet:settings-get',
    save: 'desktop-pet:settings-save',
    open: 'desktop-pet:settings-open'
} as const;

export const settingsPreferencesSchema = z.strictObject({
    hotkey: z.string().min(1).max(64).refine(isValidHotkey, {
        message: 'Use one or more modifiers plus exactly one key.'
    }),
    privacy: z.strictObject({
        localOnly: z.boolean(),
        saveTranslationHistory: z.boolean(),
        restoreClipboard: z.boolean()
    }),
    performance: z.strictObject({
        reduceMotion: z.boolean(),
        pauseWhenFullscreen: z.boolean(),
        limitFrameRate: z.boolean()
    })
});

export const settingsStateSchema = z.strictObject({
    activeProviderId: nonEmptyString.optional(),
    preferences: settingsPreferencesSchema
});

export const screenshotIpcChannels = {
    open: 'desktop-pet:screenshot-open',
    overlayViewport: 'desktop-pet:screenshot-overlay-viewport',
    select: 'desktop-pet:screenshot-select',
    cancelSelection: 'desktop-pet:screenshot-cancel-selection',
    selected: 'desktop-pet:screenshot-selected',
    translate: 'desktop-pet:screenshot-translate',
    shortcut: 'desktop-pet:screenshot-shortcut'
} as const;

export const selectionCaptureSchema = z.strictObject({
    sourceText: nonEmptyString,
    method: z.enum(['accessibility', 'clipboard']),
    clipboardRestored: z.boolean()
});

export const selectionCaptureStartSchema = z.strictObject({
    taskId: z.string().min(1).max(128)
});

export const screenshotSelectionSchema = z.strictObject({
    bounds: screenBoundsSchema
});

export const screenshotTranslationStartSchema = z.strictObject({
    bounds: screenBoundsSchema
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
export type ProviderSaveConfig = z.infer<typeof providerSaveConfigSchema>;
export type ProviderDetails = z.infer<typeof providerDetailsSchema>;
export type TranslationStatus = z.infer<typeof translationStatusSchema>;
export type TranslationTask = z.infer<typeof translationTaskSchema>;
export type TranslationRetryInput = z.infer<typeof translationRetryInputSchema>;
export type SelectionErrorCode = z.infer<typeof selectionErrorCodeSchema>;
export type TranslationErrorCode = z.infer<typeof translationErrorCodeSchema>;
export type TranslationError = z.infer<typeof translationErrorSchema>;
export type TranslationEvent = z.infer<typeof translationEventSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryPersistenceStatus = z.infer<typeof memoryPersistenceStatusSchema>;
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;
export type QuizFeedback = z.infer<typeof quizFeedbackSchema>;
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
export type ProviderErrorCode = z.infer<typeof providerErrorCodeSchema>;
export type SelectionCapture = z.infer<typeof selectionCaptureSchema>;
export type ScreenBounds = z.infer<typeof screenBoundsSchema>;
export type CapturedImage = z.infer<typeof capturedImageSchema>;
export type MascotHandle = z.infer<typeof mascotHandleSchema>;
export type HeatStatistic = z.infer<typeof heatStatisticSchema>;
export type PerformanceReason = z.infer<typeof performanceReasonSchema>;
export type PerformanceFrameRate = z.infer<typeof performanceFrameRateSchema>;
export type PerformanceMode = z.infer<typeof performanceModeSchema>;
export type SettingsPreferences = z.infer<typeof settingsPreferencesSchema>;
export type SettingsState = z.infer<typeof settingsStateSchema>;
