import { useCallback, useEffect, useState } from 'react';
import type {
    ScreenBounds,
    TranslationEvent,
    TranslationTask
} from '../shared/contracts';
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
    onTranslationEvent: (listener: (event: TranslationEvent) => void) => () => void;
    onSelectionShortcut: (listener: () => void) => () => void;
    onScreenshotShortcut: (listener: () => void) => () => void;
}

declare global {
    interface Window {
        desktopPet: DesktopPetApi;
    }
}

export default function App(): React.JSX.Element {
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
    const [screenshotSelection, setScreenshotSelection] = useState(false);
    const [screenshotViewport, setScreenshotViewport] = useState<ScreenBounds>({
        x: 0,
        y: 0,
        width: 1,
        height: 1
    });
    const [screenshotBounds, setScreenshotBounds] = useState<ScreenBounds>();
    const startTranslation = useCallback(async (): Promise<void> => {
        setScreenshotBounds(undefined);
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
            setTranslation((current) => translationBubbleReducer(current, {
                type: 'completed',
                task
            }));
        } catch {
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
    }, []);

    const startScreenshotTranslation = useCallback(async (
        bounds: ScreenBounds
    ): Promise<void> => {
        setScreenshotBounds(bounds);
        setScreenshotSelection(false);
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
            setTranslation((current) => translationBubbleReducer(current, {
                type: 'completed',
                task
            }));
        } catch {
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
    }, []);

    const openScreenshotSelection = useCallback((): void => {
        setScreenshotViewport({
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight
        });
        setScreenshotSelection(true);
    }, []);

    useEffect(() => {
        const removeEvents = window.desktopPet.onTranslationEvent((event) => {
            setTranslation((current) => translationBubbleReducer(current, event));
        });
        const removeShortcut = window.desktopPet.onSelectionShortcut(() => {
            void startTranslation();
        });
        const removeScreenshotShortcut = window.desktopPet.onScreenshotShortcut(
            openScreenshotSelection
        );
        return () => {
            removeEvents();
            removeShortcut();
            removeScreenshotShortcut();
        };
    }, [openScreenshotSelection, startTranslation]);

    return (
        <main>
            <h1>Desktop Pet Translator</h1>
            <button type="button" onClick={() => void startTranslation()}>
                Translate selection
            </button>
            <button type="button" onClick={openScreenshotSelection}>
                Translate screenshot
            </button>
            {screenshotSelection ? (
                <RegionSelector
                    active
                    viewport={screenshotViewport}
                    onSelect={(bounds) => void startScreenshotTranslation(bounds)}
                    onCancel={() => setScreenshotSelection(false)}
                />
            ) : null}
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
    );
}
