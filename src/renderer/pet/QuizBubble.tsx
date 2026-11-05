import { useEffect, useRef, useState } from 'react';
import type {
    MascotEvent,
    QuizFeedback,
    QuizQuestion
} from '../../shared/contracts';

export type QuizOutcome = 'correct' | 'wrong' | 'skipped' | 'paused';

export interface QuizBubbleProps {
    question: QuizQuestion;
    paused: boolean;
    onAnswer: (optionIndex: number) => Promise<QuizFeedback>;
    onSkip: () => Promise<QuizFeedback>;
    onPauseChange: (paused: boolean) => Promise<void> | void;
    onNext?: () => Promise<void> | void;
    onMascotEvent?: (event: MascotEvent) => void;
}

export function quizOutcomeToMascotEvent(outcome: QuizOutcome): MascotEvent {
    switch (outcome) {
        case 'correct':
            return 'happy';
        case 'wrong':
            return 'sad';
        case 'skipped':
        case 'paused':
            return 'idle';
    }
}

function submissionErrorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Quiz submission failed.';
}

export default function QuizBubble({
    question,
    paused,
    onAnswer,
    onSkip,
    onPauseChange,
    onNext,
    onMascotEvent
}: QuizBubbleProps): React.JSX.Element {
    const [feedback, setFeedback] = useState<QuizFeedback>();
    const [feedbackLabel, setFeedbackLabel] = useState('Correct');
    const [submissionError, setSubmissionError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const submissionInFlightRef = useRef(false);
    const terminalSubmissionRef = useRef(false);
    const terminal = feedback !== undefined || submissionError !== undefined;

    useEffect(() => {
        setFeedback(undefined);
        setFeedbackLabel('Correct');
        setSubmissionError(undefined);
        submissionInFlightRef.current = false;
        terminalSubmissionRef.current = false;
    }, [question]);

    const answer = async (optionIndex: number): Promise<void> => {
        if (paused || busy || terminalSubmissionRef.current)
            return;
        submissionInFlightRef.current = true;
        terminalSubmissionRef.current = true;
        setBusy(true);
        setSubmissionError(undefined);
        try {
            const result = await onAnswer(optionIndex);
            setFeedback(result);
            setFeedbackLabel(result.correct ? 'Correct' : 'Not quite');
            onMascotEvent?.(quizOutcomeToMascotEvent(
                result.correct ? 'correct' : 'wrong'
            ));
        } catch (error) {
            setSubmissionError(submissionErrorMessage(error));
        } finally {
            submissionInFlightRef.current = false;
            setBusy(false);
        }
    };

    const skip = async (): Promise<void> => {
        if (paused || busy || terminalSubmissionRef.current)
            return;
        submissionInFlightRef.current = true;
        terminalSubmissionRef.current = true;
        setBusy(true);
        setSubmissionError(undefined);
        try {
            setFeedback(await onSkip());
            setFeedbackLabel('Skipped');
            onMascotEvent?.(quizOutcomeToMascotEvent('skipped'));
        } catch (error) {
            setSubmissionError(submissionErrorMessage(error));
        } finally {
            submissionInFlightRef.current = false;
            setBusy(false);
        }
    };

    const togglePaused = async (): Promise<void> => {
        if (busy || submissionInFlightRef.current)
            return;
        setBusy(true);
        setSubmissionError(undefined);
        try {
            await onPauseChange(!paused);
            onMascotEvent?.(quizOutcomeToMascotEvent('paused'));
        } catch (error) {
            setSubmissionError(submissionErrorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const next = async (): Promise<void> => {
        if (onNext === undefined || busy || submissionInFlightRef.current)
            return;
        setBusy(true);
        try {
            await onNext();
        } catch (error) {
            setSubmissionError(submissionErrorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section aria-label="Vocabulary quiz">
            <h2>Quick quiz</h2>
            <p>{question.prompt}</p>
            <p><small>{question.contextHint}</small></p>
            <div role="group" aria-label="Quiz answers">
                {question.options.map((option, optionIndex) => (
                    <button
                        key={option}
                        type="button"
                        aria-label={`Answer option ${optionIndex + 1}: ${option}`}
                        disabled={paused || busy || terminal}
                        onClick={() => void answer(optionIndex)}
                    >
                        {option}
                    </button>
                ))}
            </div>
            {submissionError === undefined ? null : (
                <output role="alert" aria-live="assertive">
                    {submissionError}
                </output>
            )}
            {terminal && onNext !== undefined ? (
                <>
                    {feedback === undefined ? null : (
                        <output aria-live="polite">
                            {feedbackLabel}
                        </output>
                    )}
                    <button type="button" disabled={busy} onClick={() => void next()}>
                        Next question
                    </button>
                </>
            ) : feedback === undefined ? null : (
                <output aria-live="polite">
                    {feedbackLabel}
                </output>
            )}
            <button
                type="button"
                disabled={paused || busy || terminal}
                onClick={() => void skip()}
            >
                Skip
            </button>
            <button type="button" disabled={busy} onClick={() => void togglePaused()}>
                {paused ? 'Resume quizzes' : 'Pause quizzes'}
            </button>
        </section>
    );
}
