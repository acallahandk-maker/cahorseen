export interface QuizInterruptionState {
    fullscreen: boolean;
    activeTranslation: boolean;
    intenseInput: boolean;
}

export type QuizSuppressionReason = keyof QuizInterruptionState;

export function shouldSuppressQuizInterruptions(
    state: QuizInterruptionState
): boolean {
    return state.fullscreen
        || state.activeTranslation
        || state.intenseInput;
}

export class SystemIntegration {
    private fullscreen = false;
    private activeTranslation = false;
    private intenseInput = false;

    getQuizInterruptionState(): QuizInterruptionState {
        return {
            fullscreen: this.fullscreen,
            activeTranslation: this.activeTranslation,
            intenseInput: this.intenseInput
        };
    }

    getQuizSuppressionReason(): QuizSuppressionReason | undefined {
        const state = this.getQuizInterruptionState();
        if (state.fullscreen)
            return 'fullscreen';
        if (state.activeTranslation)
            return 'activeTranslation';
        if (state.intenseInput)
            return 'intenseInput';
        return undefined;
    }

    setFullscreen(fullscreen: boolean): void {
        this.fullscreen = fullscreen;
    }

    setActiveTranslation(activeTranslation: boolean): void {
        this.activeTranslation = activeTranslation;
    }

    setIntenseInput(intenseInput: boolean): void {
        this.intenseInput = intenseInput;
    }

    canStartQuiz(): boolean {
        return !shouldSuppressQuizInterruptions(this.getQuizInterruptionState());
    }

    canAnswerQuiz(): boolean {
        return this.canStartQuiz();
    }
}
