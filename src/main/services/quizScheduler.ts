import {
    quizPreferencesPatchSchema,
    quizQuestionSchema,
    type MemoryEntry,
    type MemoryEntryQuery,
    type QuizFeedback,
    type QuizPreferences,
    type QuizPreferencesPatch,
    type QuizQuestion
} from '../../shared/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PREFERENCES: QuizPreferences = {
    paused: false,
    frequencyWeights: {
        occurrenceCount: 1,
        recentOccurrenceCount: 0.25
    }
};
const INTERVAL_PROGRESSION = [1, 3, 7, 14] as const;

export type QuizSchedulerErrorCode =
    | 'invalid-request'
    | 'not-found'
    | 'paused'
    | 'suppressed';

export class QuizSchedulerError extends Error {
    readonly code: QuizSchedulerErrorCode;

    constructor(code: QuizSchedulerErrorCode, message: string) {
        super(message);
        this.name = 'QuizSchedulerError';
        this.code = code;
    }
}

export interface QuizScheduleUpdate {
    quizIntervalDays: number;
    nextDueAt: string;
}

export interface QuizScheduleRepository {
    listEntries(query?: MemoryEntryQuery): Promise<MemoryEntry[]>;
    updateQuizSchedule(id: string, update: QuizScheduleUpdate): Promise<void>;
}

export interface QuizSchedulerOptions {
    repository: QuizScheduleRepository;
    now?: () => Date;
    canStartQuiz?: () => boolean;
    canAnswerQuiz?: () => boolean;
}

interface PendingQuestion {
    entry: MemoryEntry;
    correctOptionIndex: number;
}

export class QuizScheduler {
    private readonly repository: QuizScheduleRepository;
    private readonly now: () => Date;
    private readonly canStartQuiz: () => boolean;
    private readonly canAnswerQuiz: () => boolean;
    private preferences: QuizPreferences = DEFAULT_PREFERENCES;
    private readonly pendingQuestions = new Map<string, PendingQuestion>();

    constructor(options: QuizSchedulerOptions) {
        this.repository = options.repository;
        this.now = options.now ?? (() => new Date());
        this.canStartQuiz = options.canStartQuiz ?? (() => true);
        this.canAnswerQuiz = options.canAnswerQuiz ?? (() => true);
    }

    async selectQuizQuestions(count = 1): Promise<QuizQuestion[]> {
        if (!Number.isInteger(count) || count < 1 || count > 20)
            throw new QuizSchedulerError(
                'invalid-request',
                'Quiz question count must be between 1 and 20.'
            );
        const requestedCount = count;
        if (this.preferences.paused)
            return [];
        if (!this.canStartQuiz())
            return [];

        const entries = await this.repository.listEntries({ limit: 10_000 });
        const nowMs = this.now().getTime();
        const dueEntries = entries
            .filter((entry) => Date.parse(entry.nextDueAt) <= nowMs)
            .sort((left, right) => this.compareDueEntries(left, right));
        const distractorEntries = entries
            .filter((entry) => entry.translatedText.trim().length > 0)
            .sort((left, right) => compareIds(left.id, right.id));
        const questions: QuizQuestion[] = [];

        for (const entry of dueEntries) {
            if (questions.length >= requestedCount)
                break;
            const question = this.createQuestion(entry, distractorEntries);
            if (question === undefined)
                continue;
            questions.push(question);
            this.pendingQuestions.set(question.id, {
                entry,
                correctOptionIndex: question.options.indexOf(entry.translatedText.trim())
            });
        }
        return questions;
    }

    async recordQuizAnswer(
        questionId: string,
        optionIndex?: number | null
    ): Promise<QuizFeedback> {
        if (this.preferences.paused)
            throw new QuizSchedulerError('paused', 'Quiz answering is paused.');
        if (!this.canAnswerQuiz())
            throw new QuizSchedulerError('suppressed', 'Quiz answering is suppressed.');
        const pending = this.pendingQuestions.get(questionId);
        if (pending === undefined)
            throw new QuizSchedulerError(
                'not-found',
                'Quiz question was not selected by this scheduler.'
            );
        const answerIndex = optionIndex === undefined || optionIndex === -1
            ? null
            : optionIndex;
        if (answerIndex !== null
            && (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3))
            throw new QuizSchedulerError(
                'invalid-request',
                'Quiz option index must be between 0 and 3.'
            );

        const currentDays = pending.entry.quizIntervalDays;
        const nextIntervalDays = answerIndex === null
            ? currentDays
            : answerIndex === pending.correctOptionIndex
                ? nextInterval(currentDays)
                : 1;
        const nextDueAt = new Date(
            this.now().getTime() + nextIntervalDays * DAY_MS
        ).toISOString();
        await this.repository.updateQuizSchedule(questionId, {
            quizIntervalDays: nextIntervalDays,
            nextDueAt
        });
        this.pendingQuestions.delete(questionId);
        return {
            correct: answerIndex === pending.correctOptionIndex,
            correctOptionIndex: pending.correctOptionIndex,
            nextDueAt
        };
    }

    async setQuizPreferences(preferences: QuizPreferencesPatch): Promise<void> {
        const parsed = quizPreferencesPatchSchema.parse(preferences);
        this.preferences = {
            paused: parsed.paused ?? this.preferences.paused,
            frequencyWeights: parsed.frequencyWeights
                ?? this.preferences.frequencyWeights
        };
        if (this.preferences.paused)
            this.pendingQuestions.clear();
    }

    private compareDueEntries(left: MemoryEntry, right: MemoryEntry): number {
        return frequencyScore(right, this.preferences.frequencyWeights)
            - frequencyScore(left, this.preferences.frequencyWeights)
            || Date.parse(left.nextDueAt) - Date.parse(right.nextDueAt)
            || compareIds(left.id, right.id);
    }

    private createQuestion(
        entry: MemoryEntry,
        distractorEntries: readonly MemoryEntry[]
    ): QuizQuestion | undefined {
        const correctTranslation = entry.translatedText.trim();
        if (correctTranslation.length === 0)
            return undefined;
        const candidates = distractorEntries.filter((candidate) => (
            candidate.id !== entry.id
            && candidate.translatedText.trim().length > 0
            && candidate.translatedText.trim() !== correctTranslation
        ));
        const distinctCandidates: MemoryEntry[] = [];
        const usedTranslations = new Set<string>();
        for (const candidate of candidates) {
            const translation = candidate.translatedText.trim();
            if (usedTranslations.has(translation))
                continue;
            usedTranslations.add(translation);
            distinctCandidates.push(candidate);
        }
        if (distinctCandidates.length < 3)
            return undefined;

        const offset = stableHash(entry.id) % distinctCandidates.length;
        const distractors = [0, 1, 2].map((index) => (
            distinctCandidates[(offset + index) % distinctCandidates.length]
        )).map((candidate) => candidate.translatedText.trim());
        const correctOptionIndex = stableHash(`${entry.id}:answer`) % 4;
        const options = [...distractors];
        options.splice(correctOptionIndex, 0, correctTranslation);
        return quizQuestionSchema.parse({
            id: entry.id,
            prompt: `Choose the ${entry.targetLanguage} translation of “${entry.sourceText}”.`,
            contextHint: entry.context.trim()
                || `Remembered from ${entry.sourceLanguage} to ${entry.targetLanguage}.`,
            options
        });
    }
}

function frequencyScore(
    entry: MemoryEntry,
    weights: QuizPreferences['frequencyWeights']
): number {
    return entry.occurrenceCount * weights.occurrenceCount
        + entry.recentOccurrenceCount * weights.recentOccurrenceCount;
}

function nextInterval(currentDays: number): number {
    return INTERVAL_PROGRESSION.find((days) => days > currentDays)
        ?? INTERVAL_PROGRESSION.at(-1)
        ?? 14;
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function stableHash(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
}
