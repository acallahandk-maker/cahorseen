import { describe, expect, it, vi } from 'vitest';
import { QuizScheduler } from '../../src/main/services/quizScheduler';
import type { MemoryEntry, QuizPreferences } from '../../src/shared/contracts';

function entry(
    id: string,
    occurrenceCount: number,
    recentOccurrenceCount: number
): MemoryEntry {
    return {
        id,
        sourceText: id,
        normalizedSource: id,
        translatedText: `${id} translation`,
        sourceLanguage: 'en-US',
        targetLanguage: 'fr-FR',
        occurrenceCount,
        recentOccurrenceCount,
        translationCount: occurrenceCount,
        firstSeenAt: '2026-10-01T12:00:00.000Z',
        lastUsedAt: '2026-11-01T12:00:00.000Z',
        context: id,
        quizIntervalDays: 1,
        nextDueAt: '2026-11-01T12:00:00.000Z'
    };
}

function repository(entries: MemoryEntry[]) {
    return {
        listEntries: vi.fn(async () => entries),
        updateQuizSchedule: vi.fn(async () => undefined)
    };
}

describe('final review quiz preferences', () => {
    it('persists complete frequency preferences after runtime updates', async () => {
        const persistPreferences = vi.fn(async () => undefined);
        const scheduler = new QuizScheduler({
            repository: repository([entry('a', 1, 1)]),
            persistPreferences
        });

        await scheduler.setQuizPreferences({
            frequencyWeights: {
                occurrenceCount: 20,
                recentOccurrenceCount: 80
            }
        });

        expect(persistPreferences).toHaveBeenCalledWith({
            paused: false,
            frequencyWeights: {
                occurrenceCount: 20,
                recentOccurrenceCount: 80
            }
        });
    });

    it('uses persisted frequency preferences when scheduling starts', async () => {
        const entries = [
            entry('total', 10, 0),
            entry('recent', 1, 10),
            entry('distractor-a', 1, 1),
            entry('distractor-b', 1, 1),
            entry('distractor-c', 1, 1)
        ];
        const scheduler = new QuizScheduler({
            repository: repository(entries),
            initialPreferences: {
                paused: false,
                frequencyWeights: {
                    occurrenceCount: 0,
                    recentOccurrenceCount: 1
                }
            } as QuizPreferences
        } as never);

        const [question] = await scheduler.selectQuizQuestions(1);

        expect(question?.id).toBe('recent');
    });
});
