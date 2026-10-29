import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
    selectionCaptureSchema,
    screenBoundsSchema,
    screenshotIpcChannels,
    screenshotSelectionSchema,
    screenshotTranslationStartSchema,
    translationAckSchema,
    translationCancelSchema,
    translationErrorSchema,
    translationEventSchema,
    translationIpcChannels,
    translationStartSchema,
    translationTaskSchema,
    type SelectionCapture,
    type ScreenBounds,
    type TranslationEvent,
    type TranslationTask
} from '../shared/contracts';

const pingChannel = 'desktop-pet:ping';
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
    }
};

contextBridge.exposeInMainWorld('desktopPet', desktopPetApi);
