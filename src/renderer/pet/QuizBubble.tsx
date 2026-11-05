import { useEffect, useState } from 'react';
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
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setFeedback(undefined);
        setFeedbackLabel('Correct');
    }, [question.id]);

    const answer = async (optionIndex: number): Promise<void> => {
        if (paused || busy)
            return;
        setBusy(true);
        try {
            const result = await onAnswer(optionIndex);
            setFeedback(result);
            setFeedbackLabel(result.correct ? 'Correct' : 'Not quite');
            onMascotEvent?.(quizOutcomeToMascotEvent(
                result.correct ? 'correct' : 'wrong'
            ));
        } finally {
            setBusy(false);
        }
    };

    const skip = async (): Promise<void> => {
        if (paused || busy)
            return;
        setBusy(true);
        try {
            setFeedback(await onSkip());
            setFeedbackLabel('Skipped');
            onMascotEvent?.(quizOutcomeToMascotEvent('skipped'));
        } finally {
            setBusy(false);
        }
    };

    const togglePaused = async (): Promise<void> => {
        if (busy)
            return;
        setBusy(true);
        try {
            await onPauseChange(!paused);
            onMascotEvent?.(quizOutcomeToMascotEvent('paused'));
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
                        disabled={paused || busy}
                        onClick={() => void answer(optionIndex)}
                    >
                        {option}
                    </button>
                ))}
            </div>
            {feedback === undefined ? null : (
                <>
                    <output aria-live="polite">
                        {feedbackLabel}
                    </output>
                    {onNext === undefined ? null : (
                        <button
                            type="button"
                            disabled={paused || busy}
                            onClick={() => void onNext()}
                        >
                            Next question
                        </button>
                    )}
                </>
            )}
            <button type="button" disabled={paused || busy} onClick={() => void skip()}>
                Skip
            </button>
            <button type="button" disabled={busy} onClick={() => void togglePaused()}>
                {paused ? 'Resume quizzes' : 'Pause quizzes'}
            </button>
        </section>
    );
}
