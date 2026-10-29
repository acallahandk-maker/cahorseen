import { useCallback, useEffect, useState } from 'react';
import type {
    MascotEvent,
    ScreenBounds,
    TranslationEvent,
    TranslationTask
} from '../shared/contracts';
import PetWindow from './pet/PetWindow';
import RegionSelector from './screenshot/RegionSelector';
import TranslationBubble from './translation/TranslationBubble';
import {
    translationBubbleReducer,
    type TranslationBubbleState
} from './translation/translationState';

interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
    captureSelectionOnce: () => Promise<unknown>;
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

declare global {
    interface Window {
        desktopPet: DesktopPetApi;
    }
}

function isScreenshotOverlayMode(): boolean {
    return new URLSearchParams(window.location.search).get('screenshot-overlay') === '1';
}

function ScreenshotOverlay(): React.JSX.Element | null {
    const [viewport, setViewport] = useState<ScreenBounds>();

    useEffect(() => {
        let disposed = false;
        void window.desktopPet.getScreenshotOverlayViewport()
            .then((bounds) => {
                if (!disposed)
                    setViewport(bounds);
            })
            .catch(() => undefined);
        return () => {
            disposed = true;
        };
    }, []);

    if (viewport === undefined)
        return null;
    return (
        <RegionSelector
            active
            viewport={viewport}
            onSelect={(bounds) => {
                void window.desktopPet.submitScreenshotSelection(bounds);
            }}
            onCancel={() => {
                void window.desktopPet.cancelScreenshotSelection();
            }}
        />
    );
}

function PetApp(): React.JSX.Element {
    const [translation, setTranslation] = useState<TranslationBubbleState>({
        task: {
            id: 'starting',
            status: 'pending',
            sourceText: 'Selection translation',
            translatedText: '',
            targetLanguage: 'und'
        },
        streamDelta: ''
    });
    const [screenshotBounds, setScreenshotBounds] = useState<ScreenBounds>();
    const [mascotEvents, setMascotEvents] = useState<readonly MascotEvent[]>([]);
    const [mascotBatchId, setMascotBatchId] = useState(0);
    const emitMascotEvents = useCallback((events: readonly MascotEvent[]): void => {
        setMascotEvents(events);
        setMascotBatchId((current) => current + 1);
    }, []);
    const startTranslation = useCallback(async (): Promise<void> => {
        setScreenshotBounds(undefined);
        emitMascotEvents(['listening', 'thinking']);
        setTranslation({
            task: {
                id: 'starting',
                status: 'running',
                sourceText: 'Capturing selected text',
                translatedText: '',
                targetLanguage: 'und'
            },
            streamDelta: ''
        });
        try {
            const task = await window.desktopPet.translateSelection();
            emitMascotEvents(['success']);
            setTranslation((current) => translationBubbleReducer(current, {
                type: 'completed',
                task
            }));
        } catch {
            emitMascotEvents(['error']);
            setTranslation((current) => current.task.id === 'starting'
                ? translationBubbleReducer(current, {
                    type: 'failed',
                    taskId: 'starting',
                    error: {
                        code: 'request-failed',
                        message: 'Selection translation failed.'
                    }
                })
                : current);
        }
    }, [emitMascotEvents]);

    const startScreenshotTranslation = useCallback(async (
        bounds: ScreenBounds
    ): Promise<void> => {
        setScreenshotBounds(bounds);
        emitMascotEvents(['listening', 'thinking']);
        setTranslation({
            task: {
                id: 'screenshot-starting',
                status: 'running',
                sourceText: 'Screenshot region',
                translatedText: '',
                targetLanguage: 'und'
            },
            streamDelta: ''
        });
        try {
            const task = await window.desktopPet.translateScreenshot(bounds);
            emitMascotEvents(['success']);
            setTranslation((current) => translationBubbleReducer(current, {
                type: 'completed',
                task
            }));
        } catch {
            emitMascotEvents(['error']);
            setTranslation((current) => current.task.status === 'running'
                ? translationBubbleReducer(current, {
                    type: 'failed',
                    taskId: current.task.id,
                    error: {
                        code: 'request-failed',
                        message: 'Screenshot translation failed.'
                    }
                })
                : current);
        }
    }, [emitMascotEvents]);

    const openScreenshotSelection = useCallback((): void => {
        void window.desktopPet.openScreenshotSelection().catch(() => undefined);
    }, []);

    useEffect(() => {
        const removeEvents = window.desktopPet.onTranslationEvent((event) => {
            setTranslation((current) => translationBubbleReducer(current, event));
            if (event.type === 'completed')
                emitMascotEvents(['success']);
            else if (event.type === 'failed')
                emitMascotEvents(['error']);
        });
        const removeShortcut = window.desktopPet.onSelectionShortcut(() => {
            void startTranslation();
        });
        const removeScreenshotSelection = window.desktopPet.onScreenshotSelection(
            ({ bounds }) => {
                void startScreenshotTranslation(bounds);
            }
        );
        return () => {
            removeEvents();
            removeShortcut();
            removeScreenshotSelection();
        };
    }, [emitMascotEvents, startScreenshotTranslation, startTranslation]);

    return (
        <PetWindow eventBatch={mascotEvents} eventBatchId={mascotBatchId}>
            <main>
                <h1>Desktop Pet Translator</h1>
                <button type="button" onClick={() => void startTranslation()}>
                    Translate selection
                </button>
                <button type="button" onClick={openScreenshotSelection}>
                    Translate screenshot
                </button>
                <TranslationBubble
                    task={translation.task}
                    streamDelta={translation.streamDelta}
                    onCopy={() => void navigator.clipboard?.writeText(
                        translation.task.translatedText
                    )}
                    onRetry={() => {
                        if (screenshotBounds !== undefined)
                            void startScreenshotTranslation(screenshotBounds);
                        else
                            void startTranslation();
                    }}
                    onCancel={() => void window.desktopPet.cancelTranslation(translation.task.id)}
                />
            </main>
        </PetWindow>
    );
}

export default function App(): React.JSX.Element | null {
    return isScreenshotOverlayMode()
        ? <ScreenshotOverlay />
        : <PetApp />;
}
