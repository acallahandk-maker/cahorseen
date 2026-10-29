import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
    connectionTestResultSchema,
    providerDetailsSchema,
    providerDeleteSchema,
    providerSaveConfigSchema,
    providerSummarySchema,
    selectionCaptureSchema,
    screenBoundsSchema,
    screenshotIpcChannels,
    screenshotSelectionSchema,
    screenshotTranslationStartSchema,
    settingsIpcChannels,
    settingsPreferencesSchema,
    settingsStateSchema,
    translationAckSchema,
    translationCancelSchema,
    translationErrorSchema,
    translationEventSchema,
    translationIpcChannels,
    translationStartSchema,
    translationTaskSchema,
    type ConnectionTestResult,
    type ProviderDetails,
    type ProviderSaveConfig,
    type ProviderSummary,
    type SelectionCapture,
    type ScreenBounds,
    type SettingsPreferences,
    type SettingsState,
    type TranslationEvent,
    type TranslationTask
} from '../shared/contracts';

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

const ipcFailureSchema = z.strictObject({
    ok: z.literal(false),
    error: translationErrorSchema
});

function successSchema<T>(value: z.ZodType<T>) {
    return z.strictObject({
        ok: z.literal(true),
        value
    });
}

export interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
    captureSelectionOnce: () => Promise<SelectionCapture>;
    translateSelection: () => Promise<TranslationTask>;
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
        request: { kind: 'selection' } | { kind: 'screenshot'; bounds: ScreenBounds }
    ) => Promise<TranslationTask>;
}

function parseResult<T>(
    schema: z.ZodType<T>,
    raw: unknown
): T {
    const resultSchema = z.union([successSchema(schema), ipcFailureSchema]);
    const parsed = resultSchema.parse(raw);
    if (!parsed.ok)
        throw new Error(parsed.error.message);
    return parsed.value;
}

function parseAck(raw: unknown): void {
    const parsed = translationAckSchema.parse(raw);
    if (!parsed.ok)
        throw new Error(parsed.error.message);
}

const desktopPetApi: DesktopPetApi = {
    ping: async () => pingResponseSchema.parse(await ipcRenderer.invoke(pingChannel)),
    captureSelectionOnce: async () => parseResult(
        selectionCaptureSchema,
        await ipcRenderer.invoke(translationIpcChannels.captureSelection)
    ),
    translateSelection: async () => {
        const request = translationStartSchema.parse({});
        return parseResult(
            translationTaskSchema,
            await ipcRenderer.invoke(translationIpcChannels.translateSelection, request)
        );
    },
    translateScreenshot: async (bounds) => {
        const request = screenshotTranslationStartSchema.parse({ bounds });
        return parseResult(
            translationTaskSchema,
            await ipcRenderer.invoke(screenshotIpcChannels.translate, request)
        );
    },
    saveProvider: async (provider) => {
        const request = providerSaveConfigSchema.parse(provider);
        return parseResult(
            providerSummarySchema,
            await ipcRenderer.invoke(providerChannels.save, request)
        );
    },
    deleteProvider: async (providerId) => {
        const request = providerDeleteSchema.parse({ providerId });
        parseAck(await ipcRenderer.invoke(providerChannels.delete, request));
    },
    setActiveProvider: async (providerId) => {
        const request = providerDeleteSchema.parse({ providerId });
        parseAck(await ipcRenderer.invoke(providerChannels.setActive, request));
    },
    getProviderSummaries: async () => parseResult(
        z.array(providerSummarySchema),
        await ipcRenderer.invoke(providerChannels.summaries, {})
    ),
    getProviderDetails: async (providerId) => parseResult(
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
        return parseResult(
            connectionTestResultSchema,
            await ipcRenderer.invoke(providerChannels.test, request)
        );
    },
    getSettings: async () => parseResult(
        settingsStateSchema,
        await ipcRenderer.invoke(settingsIpcChannels.get, {})
    ),
    saveSettings: async (preferences) => {
        const request = settingsPreferencesSchema.parse(preferences);
        return parseResult(
            settingsStateSchema,
            await ipcRenderer.invoke(settingsIpcChannels.save, request)
        );
    },
    openSettings: async () => {
        parseAck(await ipcRenderer.invoke(settingsIpcChannels.open, {}));
    },
    cancelTranslation: async (taskId) => {
        const request = translationCancelSchema.parse({ taskId });
        parseAck(await ipcRenderer.invoke(translationIpcChannels.cancel, request));
    },
    openScreenshotSelection: async () => {
        parseAck(await ipcRenderer.invoke(screenshotIpcChannels.open, {}));
    },
    getScreenshotOverlayViewport: async () => parseResult(
        screenBoundsSchema,
        await ipcRenderer.invoke(screenshotIpcChannels.overlayViewport, {})
    ),
    submitScreenshotSelection: async (bounds) => {
        const request = screenshotSelectionSchema.parse({ bounds });
        parseAck(await ipcRenderer.invoke(screenshotIpcChannels.select, request));
    },
    cancelScreenshotSelection: async () => {
        parseAck(await ipcRenderer.invoke(screenshotIpcChannels.cancelSelection, {}));
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
        if (request.kind === 'selection') {
            return parseResult(
                translationTaskSchema,
                await ipcRenderer.invoke(translationIpcChannels.translateSelection, {})
            );
        }
        return parseResult(
            translationTaskSchema,
            await ipcRenderer.invoke(screenshotIpcChannels.translate, {
                bounds: screenBoundsSchema.parse(request.bounds)
            })
        );
    }
};

contextBridge.exposeInMainWorld('desktopPet', desktopPetApi);
