import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
    connectionTestResultSchema,
    providerDetailsSchema,
    providerDeleteSchema,
    providerSaveConfigSchema,
    providerSummarySchema,
    quizAnswerRequestSchema,
    quizFeedbackSchema,
    quizIpcChannels,
    quizPreferencesPatchSchema,
    quizQuestionRequestSchema,
    quizQuestionSchema,
    performanceIpcChannels,
    performanceModeSchema,
    resourcePressureIpcChannels,
    resourcePressureMetricsSchema,
    selectionCaptureStartSchema,
    selectionCaptureSchema,
    screenBoundsSchema,
    screenshotIpcChannels,
    screenshotSelectionSchema,
    screenshotTranslationStartSchema,
    settingsIpcChannels,
    settingsPreferencesSchema,
    settingsStateSchema,
    translationCancelSchema,
    translationEventSchema,
    translationIpcChannels,
    translationRetryInputSchema,
    translationStartSchema,
    translationTaskSchema,
    type ConnectionTestResult,
    type ProviderDetails,
    type ProviderSaveConfig,
    type ProviderSummary,
    type QuizApi,
    type QuizFeedback,
    type QuizPreferencesPatch,
    type PerformanceMode,
    type ResourcePressureMetrics,
    type SelectionCapture,
    type ScreenBounds,
    type SettingsPreferences,
    type SettingsState,
    type TranslationEvent,
    type TranslationRetryInput,
    type TranslationTask,
    type VocabularyRepositoryFacade
} from '../shared/contracts';
import { parseIpcAck, parseIpcResult, parseIpcTaskResult } from './ipcResult';
import { createVocabularyApi } from './vocabularyAdapter';

const pingChannel = 'desktop-pet:ping';
const providerChannels = {
    save: 'desktop-pet:provider-save',
    delete: 'desktop-pet:provider-delete',
    setActive: 'desktop-pet:provider-set-active',
    summaries: 'desktop-pet:provider-summaries',
    details: 'desktop-pet:provider-details',
    test: 'desktop-pet:provider-test'
} as const;
const pingResponseSchema = z.object({
    version: z.string().min(1)
});

export interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
    vocabulary: VocabularyRepositoryFacade;
    quiz: QuizApi;
    captureSelectionOnce: (taskId: string) => Promise<SelectionCapture>;
    translateSelection: (options?: {
        taskId?: string;
        sourceText?: string;
    }) => Promise<TranslationTask>;
    translateScreenshot: (bounds: ScreenBounds) => Promise<TranslationTask>;
    saveProvider: (provider: ProviderSaveConfig) => Promise<ProviderSummary>;
    deleteProvider: (providerId: string) => Promise<void>;
    setActiveProvider: (providerId: string) => Promise<void>;
    getProviderSummaries: () => Promise<ProviderSummary[]>;
    getProviderDetails: (providerId: string) => Promise<ProviderDetails>;
    testProvider: (
        providerId: string,
        capability: 'text' | 'vision'
    ) => Promise<ConnectionTestResult>;
    getSettings: () => Promise<SettingsState>;
    saveSettings: (preferences: SettingsPreferences) => Promise<SettingsState>;
    getPerformanceMode: () => Promise<PerformanceMode>;
    getResourcePressure: () => Promise<ResourcePressureMetrics>;
    onPerformanceChange: (
        listener: (mode: PerformanceMode) => void
    ) => () => void;
    openSettings: () => Promise<void>;
    cancelTranslation: (taskId: string) => Promise<void>;
    openScreenshotSelection: () => Promise<void>;
    getScreenshotOverlayViewport: () => Promise<ScreenBounds>;
    submitScreenshotSelection: (bounds: ScreenBounds) => Promise<void>;
    cancelScreenshotSelection: () => Promise<void>;
    onTranslationEvent: (listener: (event: TranslationEvent) => void) => () => void;
    onSelectionShortcut: (listener: () => void) => () => void;
    onScreenshotSelection: (
        listener: (selection: { bounds: ScreenBounds }) => void
    ) => () => void;
    copyTranslation: (text: string) => Promise<void>;
    speakTranslation: (text: string) => void;
    retryTranslation: (
        request: TranslationRetryInput
    ) => Promise<TranslationTask>;
}

const desktopPetApi: DesktopPetApi = {
    ping: async () => pingResponseSchema.parse(await ipcRenderer.invoke(pingChannel)),
    vocabulary: createVocabularyApi(async (channel, payload) => (
        ipcRenderer.invoke(channel, payload)
    )),
    quiz: {
        selectQuizQuestions: async (count = 1) => {
            const request = quizQuestionRequestSchema.parse({ count });
            return parseIpcResult(
                z.array(quizQuestionSchema),
                await ipcRenderer.invoke(quizIpcChannels.selectQuestions, request)
            );
        },
        recordQuizAnswer: async (
            questionId: string,
            optionIndex?: number | null
        ): Promise<QuizFeedback> => {
            const request = quizAnswerRequestSchema.parse({
                questionId,
                optionIndex
            });
            return parseIpcResult(
                quizFeedbackSchema,
                await ipcRenderer.invoke(quizIpcChannels.recordAnswer, request)
            );
        },
        setQuizPreferences: async (
            preferences: QuizPreferencesPatch
        ): Promise<void> => {
            const request = quizPreferencesPatchSchema.parse(preferences);
            parseIpcAck(
                await ipcRenderer.invoke(quizIpcChannels.setPreferences, request)
            );
        }
    },
    captureSelectionOnce: async (taskId) => {
        const request = selectionCaptureStartSchema.parse({ taskId });
        return parseIpcResult(
            selectionCaptureSchema,
            await ipcRenderer.invoke(translationIpcChannels.captureSelection, request)
        );
    },
    translateSelection: async (options) => {
        const request = translationStartSchema.parse(options ?? {});
        return parseIpcTaskResult(
            translationTaskSchema,
            await ipcRenderer.invoke(translationIpcChannels.translateSelection, request)
        );
    },
    translateScreenshot: async (bounds) => {
        const request = screenshotTranslationStartSchema.parse({ bounds });
        return parseIpcTaskResult(
            translationTaskSchema,
            await ipcRenderer.invoke(screenshotIpcChannels.translate, request)
        );
    },
    saveProvider: async (provider) => {
        const request = providerSaveConfigSchema.parse(provider);
        return parseIpcResult(
            providerSummarySchema,
            await ipcRenderer.invoke(providerChannels.save, request)
        );
    },
    deleteProvider: async (providerId) => {
        const request = providerDeleteSchema.parse({ providerId });
        parseIpcAck(await ipcRenderer.invoke(providerChannels.delete, request));
    },
    setActiveProvider: async (providerId) => {
        const request = providerDeleteSchema.parse({ providerId });
        parseIpcAck(await ipcRenderer.invoke(providerChannels.setActive, request));
    },
    getProviderSummaries: async () => parseIpcResult(
        z.array(providerSummarySchema),
        await ipcRenderer.invoke(providerChannels.summaries, {})
    ),
    getProviderDetails: async (providerId) => parseIpcResult(
        providerDetailsSchema,
        await ipcRenderer.invoke(providerChannels.details, {
            providerId: providerDeleteSchema.parse({ providerId }).providerId
        })
    ),
    testProvider: async (providerId, capability) => {
        const request = z.strictObject({
            providerId: z.string().min(1),
            capability: z.enum(['text', 'vision'])
        }).parse({ providerId, capability });
        return parseIpcResult(
            connectionTestResultSchema,
            await ipcRenderer.invoke(providerChannels.test, request)
        );
    },
    getSettings: async () => parseIpcResult(
        settingsStateSchema,
        await ipcRenderer.invoke(settingsIpcChannels.get, {})
    ),
    saveSettings: async (preferences) => {
        const request = settingsPreferencesSchema.parse(preferences);
        return parseIpcResult(
            settingsStateSchema,
            await ipcRenderer.invoke(settingsIpcChannels.save, request)
        );
    },
    getPerformanceMode: async () => parseIpcResult(
        performanceModeSchema,
        await ipcRenderer.invoke(performanceIpcChannels.get, {})
    ),
    getResourcePressure: async () => parseIpcResult(
        resourcePressureMetricsSchema,
        await ipcRenderer.invoke(resourcePressureIpcChannels.get, {})
    ),
    onPerformanceChange: (listener) => {
        const channelListener = (
            _event: Electron.IpcRendererEvent,
            payload: unknown
        ): void => {
            listener(performanceModeSchema.parse(payload));
        };
        ipcRenderer.on(performanceIpcChannels.changed, channelListener);
        return () => {
            ipcRenderer.removeListener(
                performanceIpcChannels.changed,
                channelListener
            );
        };
    },
    openSettings: async () => {
        parseIpcAck(await ipcRenderer.invoke(settingsIpcChannels.open, {}));
    },
    cancelTranslation: async (taskId) => {
        const request = translationCancelSchema.parse({ taskId });
        parseIpcAck(await ipcRenderer.invoke(translationIpcChannels.cancel, request));
    },
    openScreenshotSelection: async () => {
        parseIpcAck(await ipcRenderer.invoke(screenshotIpcChannels.open, {}));
    },
    getScreenshotOverlayViewport: async () => parseIpcResult(
        screenBoundsSchema,
        await ipcRenderer.invoke(screenshotIpcChannels.overlayViewport, {})
    ),
    submitScreenshotSelection: async (bounds) => {
        const request = screenshotSelectionSchema.parse({ bounds });
        parseIpcAck(await ipcRenderer.invoke(screenshotIpcChannels.select, request));
    },
    cancelScreenshotSelection: async () => {
        parseIpcAck(await ipcRenderer.invoke(screenshotIpcChannels.cancelSelection, {}));
    },
    onTranslationEvent: (listener) => {
        const channelListener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
            listener(translationEventSchema.parse(payload));
        };
        ipcRenderer.on(translationIpcChannels.event, channelListener);
        return () => {
            ipcRenderer.removeListener(translationIpcChannels.event, channelListener);
        };
    },
    onSelectionShortcut: (listener) => {
        const channelListener = (): void => {
            listener();
        };
        ipcRenderer.on(translationIpcChannels.selectionShortcut, channelListener);
        return () => {
            ipcRenderer.removeListener(
                translationIpcChannels.selectionShortcut,
                channelListener
            );
        };
    },
    onScreenshotSelection: (listener) => {
        const channelListener = (
            _event: Electron.IpcRendererEvent,
            payload: unknown
        ): void => {
            listener(screenshotSelectionSchema.parse(payload));
        };
        ipcRenderer.on(screenshotIpcChannels.selected, channelListener);
        return () => {
            ipcRenderer.removeListener(
                screenshotIpcChannels.selected,
                channelListener
            );
        };
    },
    copyTranslation: async (text) => {
        await navigator.clipboard.writeText(text);
    },
    speakTranslation: (text) => {
        const utterance = new SpeechSynthesisUtterance(text);
        window.speechSynthesis.speak(utterance);
    },
    retryTranslation: async (request) => {
        const parsedRequest = translationRetryInputSchema.parse(request);
        if (parsedRequest.kind === 'selection') {
            return parseIpcTaskResult(
                translationTaskSchema,
                await ipcRenderer.invoke(
                    translationIpcChannels.translateSelection,
                    translationStartSchema.parse({
                        sourceText: parsedRequest.sourceText
                    })
                )
            );
        }
        if (parsedRequest.kind === 'selection-capture') {
            return parseIpcTaskResult(
                translationTaskSchema,
                await ipcRenderer.invoke(
                    translationIpcChannels.translateSelection,
                    translationStartSchema.parse({})
                )
            );
        }
        return parseIpcTaskResult(
            translationTaskSchema,
            await ipcRenderer.invoke(screenshotIpcChannels.translate, {
                bounds: screenBoundsSchema.parse(parsedRequest.bounds)
            })
        );
    }
};

contextBridge.exposeInMainWorld('desktopPet', desktopPetApi);
