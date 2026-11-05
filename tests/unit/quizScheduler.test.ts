import { describe, expect, it, vi } from 'vitest';
import {
    QuizScheduler,
    type QuizScheduleRepository
} from '../../src/main/services/quizScheduler';
import type {
    MemoryEntry,
    MemoryEntryQuery,
    QuizFeedback,
    QuizPreferencesPatch
} from '../../src/shared/contracts';

const now = new Date('2026-11-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id: 'entry-alpha',
        sourceText: 'alpha',
        normalizedSource: 'alpha',
        translatedText: 'Alpha translation',
        sourceLanguage: 'en-US',
        targetLanguage: 'zh-CN',
        occurrenceCount: 1,
        recentOccurrenceCount: 0,
        translationCount: 1,
        firstSeenAt: '2026-10-01T12:00:00.000Z',
        lastUsedAt: '2026-11-01T12:00:00.000Z',
        context: 'At the station',
        quizIntervalDays: 1,
        nextDueAt: '2026-11-05T12:00:00.000Z',
        ...overrides
    };
}

function entriesFixture(): MemoryEntry[] {
    return [
        makeEntry(),
        makeEntry({
            id: 'entry-beta',
            sourceText: 'beta',
            normalizedSource: 'beta',
            translatedText: 'Beta translation',
            occurrenceCount: 5,
            recentOccurrenceCount: 2,
            translationCount: 5,
            context: 'At the market',
            quizIntervalDays: 3,
            nextDueAt: '2026-11-04T12:00:00.000Z'
        }),
        makeEntry({
            id: 'entry-gamma',
            sourceText: 'gamma',
            normalizedSource: 'gamma',
            translatedText: 'Gamma translation',
            occurrenceCount: 3,
            recentOccurrenceCount: 5,
            translationCount: 3,
            context: 'On the train',
            quizIntervalDays: 7,
            nextDueAt: '2026-11-03T12:00:00.000Z'
        }),
        makeEntry({
            id: 'entry-delta',
            sourceText: 'delta',
            normalizedSource: 'delta',
            translatedText: 'Delta translation',
            occurrenceCount: 2,
            recentOccurrenceCount: 1,
            translationCount: 2,
            context: 'At home',
            quizIntervalDays: 14,
            nextDueAt: '2026-11-02T12:00:00.000Z'
        }),
        makeEntry({
            id: 'entry-future',
            sourceText: 'future',
            normalizedSource: 'future',
            translatedText: 'Future translation',
            occurrenceCount: 100,
            recentOccurrenceCount: 100,
            translationCount: 100,
            context: 'Tomorrow',
            nextDueAt: '2026-11-06T12:00:00.000Z'
        })
    ];
}

interface RepositoryFixture extends QuizScheduleRepository {
    entries: MemoryEntry[];
    updates: Array<{ id: string; quizIntervalDays: number; nextDueAt: string }>;
    preferences: QuizPreferencesPatch;
}

function repositoryFixture(
    entries = entriesFixture(),
    onList?: (query?: MemoryEntryQuery) => void
): RepositoryFixture {
    const fixture: RepositoryFixture = {
        entries,
        updates: [],
        preferences: {},
        listEntries: vi.fn(async (query?: MemoryEntryQuery) => {
            onList?.(query);
            return fixture.entries;
        }),
        updateQuizSchedule: vi.fn(async (id, patch) => {
            fixture.updates.push({ id, ...patch });
            const entry = fixture.entries.find((candidate) => candidate.id === id);
            if (entry !== undefined) {
                entry.quizIntervalDays = patch.quizIntervalDays;
                entry.nextDueAt = patch.nextDueAt;
            }
        })
    };
    return fixture;
}

function makeScheduler(options: {
    repository?: RepositoryFixture;
    paused?: boolean;
    fullscreen?: boolean;
    activeTranslation?: boolean;
    intenseInput?: boolean;
} = {}): QuizScheduler {
    return new QuizScheduler({
        repository: options.repository ?? repositoryFixture(),
        now: () => now,
        canStartQuiz: () => !options.paused
            && !options.fullscreen
            && !options.activeTranslation
            && !options.intenseInput,
        canAnswerQuiz: () => !options.paused
            && !options.fullscreen
            && !options.activeTranslation
            && !options.intenseInput
    });
}

describe('QuizScheduler', () => {
    it('selects local due entries with stable four-option questions and context hints', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const repository = repositoryFixture();
        const scheduler = makeScheduler({ repository });

        const first = await scheduler.selectQuizQuestions(2);
        const second = await scheduler.selectQuizQuestions(2);

        expect(first).toHaveLength(2);
        expect(first.map((question) => question.id)).toEqual([
            'entry-beta',
            'entry-gamma'
        ]);
        expect(second).toEqual(first);
        for (const question of first) {
            expect(question).not.toHaveProperty('correctOptionIndex');
            expect(question).not.toHaveProperty('translatedText');
            expect(question.options).toHaveLength(4);
            expect(new Set(question.options).size).toBe(4);
            expect(question.contextHint).toMatch(/At the|On the/);
        }
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('ranks due entries by default frequency and honors custom frequency weights', async () => {
        const repository = repositoryFixture();
        const scheduler = makeScheduler({ repository });

        const defaultQuestions = await scheduler.selectQuizQuestions(1);
        await scheduler.setQuizPreferences({
            frequencyWeights: {
                occurrenceCount: 0,
                recentOccurrenceCount: 1
            }
        });
        const recentQuestions = await scheduler.selectQuizQuestions(1);

        expect(defaultQuestions[0]?.id).toBe('entry-beta');
        expect(recentQuestions[0]?.id).toBe('entry-gamma');
    });

    it.each([
        [1, 3],
        [3, 7],
        [7, 14],
        [14, 14]
    ])('advances a correct %i-day interval to %i days', async (currentDays, expectedDays) => {
        const repository = repositoryFixture([
            makeEntry({ id: 'target', quizIntervalDays: currentDays }),
            makeEntry({
                id: 'other-a',
                translatedText: 'A translation',
                nextDueAt: '2026-11-06T12:00:00.000Z'
            }),
            makeEntry({
                id: 'other-b',
                translatedText: 'B translation',
                nextDueAt: '2026-11-06T12:00:00.000Z'
            }),
            makeEntry({
                id: 'other-c',
                translatedText: 'C translation',
                nextDueAt: '2026-11-06T12:00:00.000Z'
            })
        ]);
        const scheduler = makeScheduler({ repository });
        const [question] = await scheduler.selectQuizQuestions(1);
        expect(question).toBeDefined();

        const feedback = await scheduler.recordQuizAnswer(
            question?.id ?? '',
            question?.options.indexOf('Alpha translation') ?? -1
        );

        expect(feedback.correct).toBe(true);
        expect(feedback.nextDueAt).toBe(
            new Date(now.getTime() + expectedDays * DAY_MS).toISOString()
        );
        expect(repository.updates).toEqual([{
            id: 'target',
            quizIntervalDays: expectedDays,
            nextDueAt: feedback.nextDueAt
        }]);
    });

    it('returns wrong answers to one day and skips without advancing mastery', async () => {
        const repository = repositoryFixture([
            makeEntry({ id: 'target', quizIntervalDays: 7 }),
            makeEntry({
                id: 'other-a',
                translatedText: 'A translation',
                nextDueAt: '2026-11-06T12:00:00.000Z'
            }),
            makeEntry({
                id: 'other-b',
                translatedText: 'B translation',
                nextDueAt: '2026-11-06T12:00:00.000Z'
            }),
            makeEntry({
                id: 'other-c',
                translatedText: 'C translation',
                nextDueAt: '2026-11-06T12:00:00.000Z'
            })
        ]);
        const scheduler = makeScheduler({ repository });
        const [wrongQuestion] = await scheduler.selectQuizQuestions(1);
        const wrongOption = wrongQuestion?.options.findIndex(
            (option) => option !== 'Alpha translation'
        ) ?? -1;

        const wrongFeedback = await scheduler.recordQuizAnswer(
            wrongQuestion?.id ?? '',
            wrongOption
        );

        expect(wrongFeedback).toMatchObject({
            correct: false,
            correctOptionIndex: wrongQuestion?.options.indexOf('Alpha translation'),
            nextDueAt: new Date(now.getTime() + DAY_MS).toISOString()
        });

        repository.entries[0] = {
            ...repository.entries[0],
            quizIntervalDays: 7,
            nextDueAt: now.toISOString()
        };
        const [skipQuestion] = await scheduler.selectQuizQuestions(1);
        const skipped: QuizFeedback = await scheduler.recordQuizAnswer(
            skipQuestion?.id ?? '',
            null
        );

        expect(skipped.correct).toBe(false);
        expect(skipped.nextDueAt).toBe(
            new Date(now.getTime() + 7 * DAY_MS).toISOString()
        );
        expect(repository.updates.at(-1)).toEqual({
            id: 'target',
            quizIntervalDays: 7,
            nextDueAt: skipped.nextDueAt
        });
    });

    it('stops selection and answering while paused', async () => {
        const repository = repositoryFixture();
        const scheduler = makeScheduler({ repository });
        const [question] = await scheduler.selectQuizQuestions(1);

        await scheduler.setQuizPreferences({ paused: true });

        await expect(scheduler.selectQuizQuestions(1)).resolves.toEqual([]);
        await expect(
            scheduler.recordQuizAnswer(question?.id ?? '', 0)
        ).rejects.toThrow(/paused/i);
        expect(repository.updates).toEqual([]);
    });

    it.each<[string, {
        fullscreen?: boolean;
        activeTranslation?: boolean;
        intenseInput?: boolean;
    }]>([
        ['fullscreen', { fullscreen: true }],
        ['active translation', { activeTranslation: true }],
        ['intense input', { intenseInput: true }]
    ])('does not interrupt during %s', async (_name, suppression) => {
        const scheduler = makeScheduler(suppression);

        await expect(scheduler.selectQuizQuestions(1)).resolves.toEqual([]);
    });
});
