import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    MascotEvent,
    ScreenBounds,
    SelectionCapture,
    TranslationError,
    TranslationEvent,
    TranslationRetryInput,
    TranslationTask,
    QuizQuestion,
    QuizApi,
    VocabularyRepositoryFacade
} from '../shared/contracts';
import { translationErrorCodeSchema } from '../shared/contracts';
import PetWindow from './pet/PetWindow';
import QuizBubble from './pet/QuizBubble';
import RegionSelector from './screenshot/RegionSelector';
import SettingsWindow from './settings/SettingsWindow';
import TranslationBubble from './translation/TranslationBubble';
import {
    createFailedTranslationTask,
    isSelectionCaptureRetry,
    translationBubbleReducer,
    type TranslationBubbleState
} from './translation/translationState';

interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
    vocabulary: VocabularyRepositoryFacade;
    quiz: QuizApi;
    captureSelectionOnce: (taskId: string) => Promise<SelectionCapture>;
    translateSelection: (options?: {
        taskId?: string;
        sourceText?: string;
    }) => Promise<TranslationTask>;
    translateScreenshot: (bounds: ScreenBounds) => Promise<TranslationTask>;
    openSettings: () => Promise<void>;
    copyTranslation: (text: string) => Promise<void>;
    speakTranslation: (text: string) => void;
    retryTranslation: (
        request: TranslationRetryInput
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

function applyTaskResult(
    state: TranslationBubbleState,
    task: TranslationTask
): TranslationBubbleState {
    return {
        task,
        streamDelta: task.status === 'completed' ? task.translatedText : state.streamDelta
    };
}

function applyTaskFailure(
    state: TranslationBubbleState,
    error: unknown,
    fallbackMessage: string,
    retry: TranslationRetryInput
): TranslationBubbleState {
    return {
        task: createFailedTranslationTask(
            {
                ...state.task,
                translatedText: state.streamDelta
            },
            retry,
            toTranslationError(error, fallbackMessage)
        ),
        streamDelta: state.streamDelta
    };
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
            kind: 'selection',
            sourceText: 'Selection translation',
            retryInput: { kind: 'selection-capture', strategy: 'recapture' },
            translatedText: '',
            targetLanguage: 'und'
        },
        streamDelta: ''
    });
    const [translationBusy, setTranslationBusy] = useState(false);
    const translationBusyRef = useRef(false);
    const translationRef = useRef(translation);
    translationRef.current = translation;
    const cancelledTaskIdsRef = useRef(new Set<string>());
    const [quizQuestion, setQuizQuestion] = useState<QuizQuestion>();
    const [quizPaused, setQuizPaused] = useState(false);
    const quizPausedRef = useRef(false);
    const quizLoadGenerationRef = useRef(0);
    const [mascotEvents, setMascotEvents] = useState<readonly MascotEvent[]>([]);
    const [mascotBatchId, setMascotBatchId] = useState(0);
    const emitMascotEvents = useCallback((events: readonly MascotEvent[]): void => {
        setMascotEvents(events);
        setMascotBatchId((current) => current + 1);
    }, []);
    const loadQuiz = useCallback(async (): Promise<void> => {
        const requestGeneration = ++quizLoadGenerationRef.current;
        if (translationBusyRef.current || quizPausedRef.current)
            return;
        try {
            const [question] = await window.desktopPet.quiz.selectQuizQuestions(1);
            if (
                requestGeneration !== quizLoadGenerationRef.current
                || translationBusyRef.current
                || quizPausedRef.current
            )
                return;
            setQuizQuestion(question);
            if (question !== undefined)
                emitMascotEvents(['quizzing']);
        } catch {
            if (
                requestGeneration === quizLoadGenerationRef.current
                && !translationBusyRef.current
                && !quizPausedRef.current
            )
                setQuizQuestion(undefined);
        }
    }, [emitMascotEvents]);
    const runTranslationExclusive = useCallback(async (
        operation: () => Promise<void>
    ): Promise<void> => {
        if (translationBusyRef.current)
            return;
        translationBusyRef.current = true;
        quizLoadGenerationRef.current += 1;
        setTranslationBusy(true);
        setQuizQuestion(undefined);
        try {
            await operation();
        } finally {
            translationBusyRef.current = false;
            setTranslationBusy(false);
            void loadQuiz();
        }
    }, [loadQuiz]);
    const runSelectionTranslation = useCallback(async (): Promise<void> => {
        const taskId = globalThis.crypto?.randomUUID?.()
            ?? `selection-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let retry: TranslationRetryInput = {
            kind: 'selection-capture',
            strategy: 'recapture'
        };
        emitMascotEvents(['listening', 'thinking']);
        setTranslation({
            task: {
                id: taskId,
                status: 'running',
                kind: 'selection',
                sourceText: 'Capturing selected text',
                retryInput: retry,
                translatedText: '',
                targetLanguage: 'und'
            },
            streamDelta: ''
        });
        try {
            const capture = await window.desktopPet.captureSelectionOnce(taskId);
            if (
                cancelledTaskIdsRef.current.has(taskId)
                || translationRef.current.task.id !== taskId
                || translationRef.current.task.status !== 'running'
            )
                return;
            retry = {
                kind: 'selection',
                strategy: 'reuse-source',
                sourceText: capture.sourceText
            };
            const task = await window.desktopPet.translateSelection({
                taskId,
                sourceText: capture.sourceText
            });
            if (
                cancelledTaskIdsRef.current.has(taskId)
                || translationRef.current.task.id !== taskId
                || translationRef.current.task.status !== 'running'
            )
                return;
            emitMascotEvents([task.status === 'completed' ? 'success' : 'error']);
            setTranslation((current) => applyTaskResult(current, task));
        } catch (caught) {
            if (cancelledTaskIdsRef.current.has(taskId))
                return;
            emitMascotEvents(['error']);
            setTranslation((current) => current.task.id === taskId
                ? applyTaskFailure(
                    current,
                    caught,
                    'Selection translation failed.',
                    retry
                )
                : current);
        }
    }, [emitMascotEvents]);
    const startTranslation = useCallback(async (): Promise<void> => {
        await runTranslationExclusive(runSelectionTranslation);
    }, [runSelectionTranslation, runTranslationExclusive]);

    const startScreenshotTranslation = useCallback(async (
        bounds: ScreenBounds
    ): Promise<void> => {
        await runTranslationExclusive(async () => {
            emitMascotEvents(['listening', 'thinking']);
            setTranslation({
                task: {
                    id: 'screenshot-starting',
                    status: 'running',
                    kind: 'screenshot',
                    sourceText: 'Screenshot region',
                    retryInput: {
                        kind: 'screenshot',
                        strategy: 'recapture',
                        bounds
                    },
                    translatedText: '',
                    targetLanguage: 'und'
                },
                streamDelta: ''
            });
            try {
                const task = await window.desktopPet.translateScreenshot(bounds);
                emitMascotEvents([task.status === 'completed' ? 'success' : 'error']);
                setTranslation((current) => applyTaskResult(current, task));
            } catch (caught) {
                emitMascotEvents(['error']);
                setTranslation((current) => current.task.status === 'running'
                    ? applyTaskFailure(
                        current,
                        caught,
                        'Screenshot translation failed.',
                        {
                            kind: 'screenshot',
                            strategy: 'recapture',
                            bounds
                        }
                    )
                    : current);
            }
        });
    }, [emitMascotEvents, runTranslationExclusive]);

    const retryTranslation = useCallback(async (task: TranslationTask): Promise<void> => {
        if (isSelectionCaptureRetry(task)) {
            await runTranslationExclusive(runSelectionTranslation);
            return;
        }
        await runTranslationExclusive(async () => {
            emitMascotEvents(['listening', 'thinking']);
            setTranslation({
                task: {
                    ...task,
                    id: `${task.id}-retry`,
                    status: 'running',
                    kind: task.kind,
                    bounds: task.bounds,
                    translatedText: '',
                    error: undefined,
                    errorCode: undefined
                },
                streamDelta: ''
            });
            try {
                if (task.kind === 'screenshot' && task.bounds === undefined)
                    throw new Error('Screenshot retry bounds are missing.');
                const retried = await window.desktopPet.retryTranslation(task.retryInput);
                emitMascotEvents([retried.status === 'completed' ? 'success' : 'error']);
                setTranslation((current) => applyTaskResult(current, retried));
            } catch (caught) {
                emitMascotEvents(['error']);
                setTranslation((current) => current.task.status === 'running'
                    ? applyTaskFailure(
                        current,
                        caught,
                        'Translation retry failed.',
                        task.retryInput
                    )
                    : current);
            }
        });
    }, [emitMascotEvents, runSelectionTranslation, runTranslationExclusive]);

    const openScreenshotSelection = useCallback((): void => {
        void window.desktopPet.openScreenshotSelection().catch(() => undefined);
    }, []);

    const openSettings = useCallback((): void => {
        void window.desktopPet.openSettings().catch(() => undefined);
    }, []);

    useEffect(() => {
        void loadQuiz();
    }, [loadQuiz]);

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
                    onCancel={(taskId) => {
                        cancelledTaskIdsRef.current.add(taskId);
                        void window.desktopPet.cancelTranslation(taskId).catch(() => undefined);
                    }}
                />
                {quizQuestion === undefined ? null : (
                    <QuizBubble
                        question={quizQuestion}
                        paused={quizPaused}
                        onAnswer={(optionIndex) => (
                            window.desktopPet.quiz.recordQuizAnswer(
                                quizQuestion.id,
                                optionIndex
                            )
                        )}
                        onSkip={() => (
                            window.desktopPet.quiz.recordQuizAnswer(
                                quizQuestion.id,
                                null
                            )
                        )}
                        onPauseChange={async (paused) => {
                            await window.desktopPet.quiz.setQuizPreferences({ paused });
                            quizPausedRef.current = paused;
                            setQuizPaused(paused);
                            if (!paused)
                                await loadQuiz();
                        }}
                        onNext={loadQuiz}
                        onMascotEvent={(event) => emitMascotEvents([event])}
                    />
                )}
            </main>
        </PetWindow>
    );
}

export default function App(): React.JSX.Element | null {
    if (isScreenshotOverlayMode())
        return <ScreenshotOverlay />;
    if (isSettingsMode())
        return (
            <SettingsWindow
                vocabularyRepository={window.desktopPet.vocabulary}
            />
        );
    return <PetApp />;
}
