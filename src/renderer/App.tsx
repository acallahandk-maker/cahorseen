import { useCallback, useEffect, useState } from 'react';
import type { TranslationEvent, TranslationTask } from '../shared/contracts';
import TranslationBubble from './translation/TranslationBubble';
import {
    translationBubbleReducer,
    type TranslationBubbleState
} from './translation/translationState';

interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
    captureSelectionOnce: () => Promise<unknown>;
    translateSelection: () => Promise<TranslationTask>;
    cancelTranslation: (taskId: string) => Promise<void>;
    onTranslationEvent: (listener: (event: TranslationEvent) => void) => () => void;
    onSelectionShortcut: (listener: () => void) => () => void;
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
    const startTranslation = useCallback(async (): Promise<void> => {
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

    useEffect(() => {
        const removeEvents = window.desktopPet.onTranslationEvent((event) => {
            setTranslation((current) => translationBubbleReducer(current, event));
        });
        const removeShortcut = window.desktopPet.onSelectionShortcut(() => {
            void startTranslation();
        });
        return () => {
            removeEvents();
            removeShortcut();
        };
    }, [startTranslation]);

    return (
        <main>
            <h1>Desktop Pet Translator</h1>
            <button type="button" onClick={() => void startTranslation()}>
                Translate selection
            </button>
            <TranslationBubble
                task={translation.task}
                streamDelta={translation.streamDelta}
                onCopy={() => void navigator.clipboard?.writeText(
                    translation.task.translatedText
                )}
                onRetry={() => void startTranslation()}
                onCancel={() => void window.desktopPet.cancelTranslation(translation.task.id)}
            />
        </main>
    );
}
