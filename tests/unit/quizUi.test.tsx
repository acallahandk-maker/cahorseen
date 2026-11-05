// @vitest-environment jsdom
import {
    act,
    cleanup,
    render,
    screen,
    waitFor
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import QuizBubble, {
    quizOutcomeToMascotEvent
} from '../../src/renderer/pet/QuizBubble';
import { transitionMascotState } from '../../src/shared/domainState';
import type {
    MascotEvent,
    QuizFeedback,
    QuizQuestion
} from '../../src/shared/contracts';

vi.mock('../../src/renderer/pet/PetWindow', () => ({
    default: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}));

const question: QuizQuestion = {
    id: 'question-1',
    prompt: 'Choose the translation of “hello”.',
    contextHint: 'A greeting at the café',
    options: ['你好', '再见', '谢谢', '请']
};

function feedback(overrides: Partial<QuizFeedback> = {}): QuizFeedback {
    return {
        correct: false,
        correctOptionIndex: 0,
        nextDueAt: '2026-11-08T12:00:00.000Z',
        ...overrides
    };
}

function installDesktopPetApi(
    overrides: Record<string, unknown> = {}
): Window['desktopPet'] {
    const api = {
        quiz: {
            selectQuizQuestions: vi.fn(async () => []),
            recordQuizAnswer: vi.fn(async () => feedback()),
            setQuizPreferences: vi.fn(async () => undefined)
        },
        captureSelectionOnce: vi.fn(async () => ({
            sourceText: 'selected text',
            method: 'clipboard',
            clipboardRestored: true
        })),
        onTranslationEvent: vi.fn(() => () => undefined),
        onSelectionShortcut: vi.fn(() => () => undefined),
        onScreenshotSelection: vi.fn(() => () => undefined),
        ...overrides
    };
    Object.defineProperty(window, 'desktopPet', {
        configurable: true,
        value: api
    });
    return api as unknown as Window['desktopPet'];
}

function PauseAwareQuiz({
    onAnswer,
    onSkip,
    onPauseChange
}: {
    onAnswer: (optionIndex: number) => Promise<QuizFeedback>;
    onSkip: () => Promise<QuizFeedback>;
    onPauseChange: (paused: boolean) => Promise<void>;
}): React.JSX.Element {
    const [paused, setPaused] = useState(false);
    return (
        <QuizBubble
            question={question}
            paused={paused}
            onAnswer={onAnswer}
            onSkip={onSkip}
            onPauseChange={async (nextPaused) => {
                await onPauseChange(nextPaused);
                setPaused(nextPaused);
            }}
        />
    );
}

afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'desktopPet');
});

describe('QuizBubble', () => {
    it('renders the hint, four local choices, answer feedback, skip, and pause controls', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn(async () => feedback({ correct: true }));
        const onMascotEvent = vi.fn();
        render(
            <QuizBubble
                question={question}
                paused={false}
                onAnswer={onAnswer}
                onSkip={vi.fn()}
                onPauseChange={vi.fn()}
                onMascotEvent={onMascotEvent}
            />
        );

        expect(screen.getByText(question.contextHint)).toBeDefined();
        expect(screen.getAllByRole('button', { name: /answer option/i })).toHaveLength(4);
        expect(screen.getByRole('button', { name: 'Skip' })).toBeDefined();
        expect(screen.getByRole('button', { name: 'Pause quizzes' })).toBeDefined();

        await user.click(screen.getByRole('button', { name: /answer option 1/i }));

        await waitFor(() => expect(screen.getByText('Correct')).toBeDefined());
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith(0);
        expect(onMascotEvent).toHaveBeenLastCalledWith('happy');
    });

    it('maps wrong, skipped, and paused outcomes to existing mascot transitions', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn(async () => feedback());
        const onSkip = vi.fn(async () => feedback());
        const onPauseChange = vi.fn();
        const onMascotEvent = vi.fn();
        const { rerender } = render(
            <QuizBubble
                question={question}
                paused={false}
                onAnswer={onAnswer}
                onSkip={onSkip}
                onPauseChange={onPauseChange}
                onMascotEvent={onMascotEvent}
            />
        );

        await user.click(screen.getByRole('button', { name: /answer option 2/i }));
        await waitFor(() => expect(screen.getByText('Not quite')).toBeDefined());
        rerender(
            <QuizBubble
                question={{ ...question, id: 'question-2' }}
                paused={false}
                onAnswer={onAnswer}
                onSkip={onSkip}
                onPauseChange={onPauseChange}
                onMascotEvent={onMascotEvent}
            />
        );
        await user.click(screen.getByRole('button', { name: 'Skip' }));
        rerender(
            <QuizBubble
                question={{ ...question, id: 'question-3' }}
                paused={false}
                onAnswer={onAnswer}
                onSkip={onSkip}
                onPauseChange={onPauseChange}
                onMascotEvent={onMascotEvent}
            />
        );
        await user.click(screen.getByRole('button', { name: 'Pause quizzes' }));

        expect(onMascotEvent.mock.calls.map(([event]) => event)).toEqual([
            'sad',
            'idle',
            'idle'
        ] satisfies MascotEvent[]);
        expect(transitionMascotState('quizzing', quizOutcomeToMascotEvent('wrong')))
            .toBe('sad');
        expect(transitionMascotState('quizzing', quizOutcomeToMascotEvent('skipped')))
            .toBe('idle');
        expect(transitionMascotState('quizzing', quizOutcomeToMascotEvent('paused')))
            .toBe('idle');

        rerender(
            <QuizBubble
                question={question}
                paused
                onAnswer={onAnswer}
                onSkip={onSkip}
                onPauseChange={onPauseChange}
                onMascotEvent={onMascotEvent}
            />
        );
        expect(screen.getByRole('button', { name: /answer option 1/i })).toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: 'Skip' })).toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: 'Resume quizzes' })).toBeDefined();
    });

    it('locks answer and skip controls after terminal feedback', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn(async () => feedback({ correct: true }));
        const onSkip = vi.fn(async () => feedback());
        render(
            <QuizBubble
                question={question}
                paused={false}
                onAnswer={onAnswer}
                onSkip={onSkip}
                onPauseChange={vi.fn()}
            />
        );

        await user.click(screen.getByRole('button', { name: /answer option 1/i }));
        await screen.findByText('Correct');
        await user.click(screen.getByRole('button', { name: /answer option 2/i }));
        await user.click(screen.getByRole('button', { name: 'Skip' }));

        expect(onAnswer).toHaveBeenCalledExactlyOnceWith(0);
        expect(onSkip).not.toHaveBeenCalled();
    });

    it('shows an error and locks controls when an answer submission rejects', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn(async (): Promise<QuizFeedback> => {
            throw new Error('Answer submission failed.');
        });
        const onSkip = vi.fn(async () => feedback());
        render(
            <QuizBubble
                question={question}
                paused={false}
                onAnswer={onAnswer}
                onSkip={onSkip}
                onPauseChange={vi.fn()}
            />
        );

        await user.click(screen.getByRole('button', { name: /answer option 1/i }));

        expect((await screen.findByRole('alert')).textContent).toBe(
            'Answer submission failed.'
        );
        expect(screen.getByRole('button', { name: /answer option 2/i }))
            .toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: 'Skip' }))
            .toHaveProperty('disabled', true);
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith(0);
        expect(onSkip).not.toHaveBeenCalled();
    });

    it('shows an error and locks controls when a skip submission rejects', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn(async () => feedback({ correct: true }));
        const onSkip = vi.fn(async (): Promise<QuizFeedback> => {
            throw new Error('Skip submission failed.');
        });
        render(
            <QuizBubble
                question={question}
                paused={false}
                onAnswer={onAnswer}
                onSkip={onSkip}
                onPauseChange={vi.fn()}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Skip' }));

        expect((await screen.findByRole('alert')).textContent).toBe(
            'Skip submission failed.'
        );
        expect(screen.getByRole('button', { name: /answer option 1/i }))
            .toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: 'Skip' }))
            .toHaveProperty('disabled', true);
        expect(onSkip).toHaveBeenCalledTimes(1);
        expect(onAnswer).not.toHaveBeenCalled();
    });

    it('does not display a quiz delivered after translation becomes active', async () => {
        const user = userEvent.setup();
        let resolveQuiz!: (questions: QuizQuestion[]) => void;
        const quizRequest = new Promise<QuizQuestion[]>((resolve) => {
            resolveQuiz = resolve;
        });
        const api = installDesktopPetApi({
            quiz: {
                selectQuizQuestions: vi.fn(async () => quizRequest),
                recordQuizAnswer: vi.fn(async () => feedback()),
                setQuizPreferences: vi.fn(async () => undefined)
            },
            captureSelectionOnce: vi.fn(async () => new Promise<never>(() => undefined))
        });

        render(<App />);
        await waitFor(() => expect(api.quiz.selectQuizQuestions).toHaveBeenCalledTimes(1));
        await user.click(screen.getByRole('button', { name: 'Translate selection' }));
        await waitFor(() => expect(api.captureSelectionOnce).toHaveBeenCalledTimes(1));

        await act(async () => {
            resolveQuiz([question]);
            await Promise.resolve();
        });

        expect(screen.queryByRole('region', { name: 'Vocabulary quiz' })).toBeNull();
    });

    it.each([
        ['answer', /answer option 1/i],
        ['skip', 'Skip']
    ] as const)(
        'keeps controls terminally disabled after pause and resume following a rejected %s',
        async (submission, controlName) => {
            const user = userEvent.setup();
            const onAnswer = vi.fn(async (): Promise<QuizFeedback> => {
                if (submission === 'answer')
                    throw new Error('Answer submission failed.');
                return feedback({ correct: true });
            });
            const onSkip = vi.fn(async (): Promise<QuizFeedback> => {
                if (submission === 'skip')
                    throw new Error('Skip submission failed.');
                return feedback();
            });
            const onPauseChange = vi.fn(async () => undefined);
            render(
                <PauseAwareQuiz
                    onAnswer={onAnswer}
                    onSkip={onSkip}
                    onPauseChange={onPauseChange}
                />
            );

            await user.click(screen.getByRole('button', { name: controlName }));
            await screen.findByRole('alert');
            await user.click(screen.getByRole('button', { name: 'Pause quizzes' }));
            await screen.findByRole('button', { name: 'Resume quizzes' });
            await user.click(screen.getByRole('button', { name: 'Resume quizzes' }));
            await screen.findByRole('button', { name: 'Pause quizzes' });

            const answerControl = screen.getByRole(
                'button',
                { name: /answer option 2/i }
            );
            const skipControl = screen.getByRole('button', { name: 'Skip' });
            expect(answerControl).toHaveProperty('disabled', true);
            expect(skipControl).toHaveProperty('disabled', true);
            await user.click(answerControl);
            await user.click(skipControl);
            expect(onAnswer).toHaveBeenCalledTimes(submission === 'answer' ? 1 : 0);
            expect(onSkip).toHaveBeenCalledTimes(submission === 'skip' ? 1 : 0);
            expect(onPauseChange).toHaveBeenCalledTimes(2);
        }
    );
});
