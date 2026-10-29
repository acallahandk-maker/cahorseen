// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    VocabularyHeatView,
    rankHeatStatistics
} from '../../src/renderer/learning/VocabularyHeatView';
import type { HeatStatistic } from '../../src/shared/contracts';

function statistic(overrides: Partial<HeatStatistic>): HeatStatistic {
    return {
        sourceText: 'Hello',
        normalizedSource: 'hello',
        translatedText: '你好',
        sourceLanguage: 'en-US',
        targetLanguage: 'zh-CN',
        occurrenceCount: 1,
        recentOccurrenceCount: 0,
        lastUsedAt: '2026-10-29T12:00:00.000Z',
        ...overrides
    };
}

afterEach(cleanup);

describe('heat statistics', () => {
    it('ranks by total count, recent count, recency, then normalized identity', () => {
        const statistics = [
            statistic({
                sourceText: 'Old hot',
                normalizedSource: 'old hot',
                occurrenceCount: 5,
                recentOccurrenceCount: 1,
                lastUsedAt: '2026-10-20T12:00:00.000Z'
            }),
            statistic({
                sourceText: 'Recent hot',
                normalizedSource: 'recent hot',
                occurrenceCount: 5,
                recentOccurrenceCount: 3,
                lastUsedAt: '2026-10-29T12:00:00.000Z'
            }),
            statistic({
                sourceText: 'Cold',
                normalizedSource: 'cold',
                occurrenceCount: 1,
                recentOccurrenceCount: 0,
                lastUsedAt: '2026-10-01T12:00:00.000Z'
            }),
            statistic({
                sourceText: 'Another',
                normalizedSource: 'another',
                occurrenceCount: 5,
                recentOccurrenceCount: 3,
                lastUsedAt: '2026-10-29T12:00:00.000Z'
            })
        ];

        expect(rankHeatStatistics(statistics).map((item) => item.normalizedSource)).toEqual([
            'another',
            'recent hot',
            'old hot',
            'cold'
        ]);
    });

    it('renders a minimal accessible data table in ranking order', () => {
        const statistics = [
            statistic({
                normalizedSource: 'first ranked',
                sourceText: 'First ranked',
                occurrenceCount: 4,
                recentOccurrenceCount: 2
            }),
            statistic({
                normalizedSource: 'second ranked',
                sourceText: 'Second ranked',
                occurrenceCount: 2,
                recentOccurrenceCount: 1
            })
        ];

        render(createElement(VocabularyHeatView, { statistics }));

        expect(screen.getByRole('table', { name: 'Vocabulary heat' })).toBeDefined();
        const rows = screen.getAllByRole('row');
        expect(rows.slice(1).map((row) => row.textContent)).toEqual([
            'First rankedfirst rankeden-USzh-CN42',
            'Second rankedsecond rankeden-USzh-CN21'
        ]);
    });
});
