import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    MascotEvent,
    ScreenBounds,
    TranslationError,
    TranslationEvent,
    TranslationTask
} from '../shared/contracts';
import { translationErrorCodeSchema } from '../shared/contracts';
import PetWindow from './pet/PetWindow';
import RegionSelector from './screenshot/RegionSelector';
import SettingsWindow from './settings/SettingsWindow';
import TranslationBubble from './translation/TranslationBubble';
import {
    translationBubbleReducer,
    type TranslationBubbleState
} from './translation/translationState';

interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
    captureSelectionOnce: () => Promise<unknown>;
    translateSelection: (options?: { sourceText?: string }) => Promise<TranslationTask>;
    translateScreenshot: (bounds: ScreenBounds) => Promise<TranslationTask>;
    openSettings: () => Promise<void>;
    copyTranslation: (text: string) => Promise<void>;
    speakTranslation: (text: string) => void;
    retryTranslation: (
        request:
            | { kind: 'selection'; sourceText: string }
            | { kind: 'screenshot'; bounds: ScreenBounds }
    ) => Promise<TranslationTask>;
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

function isSettingsMode(): boolean {
    return new URLSearchParams(window.location.search).get('settings') === '1';
}

function toTranslationError(error: unknown, fallbackMessage: string): TranslationError {
    const candidateCode = (error as { code?: unknown } | null)?.code;
    const parsedCode = translationErrorCodeSchema.safeParse(candidateCode);
    if (parsedCode.success && error instanceof Error)
        return { code: parsedCode.data, message: error.message };
    return { code: 'request-failed', message: fallbackMessage };
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
    const [translationBusy, setTranslationBusy] = useState(false);
    const translationBusyRef = useRef(false);
    const screenshotBoundsByTaskId = useRef(new Map<string, ScreenBounds>());
    const [mascotEvents, setMascotEvents] = useState<readonly MascotEvent[]>([]);
    const [mascotBatchId, setMascotBatchId] = useState(0);
    const emitMascotEvents = useCallback((events: readonly MascotEvent[]): void => {
        setMascotEvents(events);
        setMascotBatchId((current) => current + 1);
    }, []);
    const runTranslationExclusive = useCallback(async (
        operation: () => Promise<void>
    ): Promise<void> => {
        if (translationBusyRef.current)
            return;
        translationBusyRef.current = true;
        setTranslationBusy(true);
        try {
            await operation();
        } finally {
            translationBusyRef.current = false;
            setTranslationBusy(false);
        }
    }, []);
    const startTranslation = useCallback(async (): Promise<void> => {
        await runTranslationExclusive(async () => {
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
            } catch (caught) {
                emitMascotEvents(['error']);
                setTranslation((current) => current.task.id === 'starting'
                    ? translationBubbleReducer(current, {
                        type: 'failed',
                        taskId: 'starting',
                        error: toTranslationError(caught, 'Selection translation failed.')
                    })
                    : current);
            }
        });
    }, [emitMascotEvents, runTranslationExclusive]);

    const startScreenshotTranslation = useCallback(async (
        bounds: ScreenBounds
    ): Promise<void> => {
        await runTranslationExclusive(async () => {
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
                screenshotBoundsByTaskId.current.set(task.id, bounds);
                emitMascotEvents(['success']);
                setTranslation((current) => translationBubbleReducer(current, {
                    type: 'completed',
                    task
                }));
            } catch (caught) {
                emitMascotEvents(['error']);
                setTranslation((current) => current.task.status === 'running'
                    ? translationBubbleReducer(current, {
                        type: 'failed',
                        taskId: current.task.id,
                        error: toTranslationError(caught, 'Screenshot translation failed.')
                    })
                    : current);
            }
        });
    }, [emitMascotEvents, runTranslationExclusive]);

    const retryTranslation = useCallback(async (task: TranslationTask): Promise<void> => {
        await runTranslationExclusive(async () => {
            emitMascotEvents(['listening', 'thinking']);
            setTranslation({
                task: {
                    ...task,
                    id: `${task.id}-retry`,
                    status: 'running',
                    translatedText: '',
                    error: undefined,
                    errorCode: undefined
                },
                streamDelta: ''
            });
            try {
                const bounds = screenshotBoundsByTaskId.current.get(task.id);
                const retried = bounds === undefined
                    ? await window.desktopPet.retryTranslation({
                        kind: 'selection',
                        sourceText: task.sourceText
                    })
                    : await window.desktopPet.retryTranslation({
                        kind: 'screenshot',
                        bounds
                    });
                if (bounds !== undefined)
                    screenshotBoundsByTaskId.current.set(retried.id, bounds);
                emitMascotEvents(['success']);
                setTranslation((current) => translationBubbleReducer(current, {
                    type: 'completed',
                    task: retried
                }));
            } catch (caught) {
                emitMascotEvents(['error']);
                setTranslation((current) => current.task.status === 'running'
                    ? translationBubbleReducer(current, {
                        type: 'failed',
                        taskId: current.task.id,
                        error: toTranslationError(caught, 'Translation retry failed.')
                    })
                    : current);
            }
        });
    }, [emitMascotEvents, runTranslationExclusive]);

    const openScreenshotSelection = useCallback((): void => {
        void window.desktopPet.openScreenshotSelection().catch(() => undefined);
    }, []);

    const openSettings = useCallback((): void => {
        void window.desktopPet.openSettings().catch(() => undefined);
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
                <button type="button" disabled={translationBusy} onClick={() => void startTranslation()}>
                    Translate selection
                </button>
                <button type="button" disabled={translationBusy} onClick={openScreenshotSelection}>
                    Translate screenshot
                </button>
                <button type="button" onClick={openSettings}>Settings</button>
                <TranslationBubble
                    task={translation.task}
                    streamDelta={translation.streamDelta}
                    busy={translationBusy}
                    onCopy={(text) => void window.desktopPet.copyTranslation(text)}
                    onSpeak={(text) => window.desktopPet.speakTranslation(text)}
                    onRetry={retryTranslation}
                    onCancel={(taskId) => void window.desktopPet.cancelTranslation(taskId)}
                />
            </main>
        </PetWindow>
    );
}

export default function App(): React.JSX.Element | null {
    if (isScreenshotOverlayMode())
        return <ScreenshotOverlay />;
    if (isSettingsMode())
        return <SettingsWindow />;
    return <PetApp />;
}
