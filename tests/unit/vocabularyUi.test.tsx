// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsWindow from '../../src/renderer/settings/SettingsWindow';
import {
    VocabularyHeatView,
    buildVocabularyExport,
    type VocabularyEntryPatch
} from '../../src/renderer/learning/VocabularyHeatView';
import type {
    HeatStatistic,
    MemoryEntry,
    SettingsPreferences
} from '../../src/shared/contracts';

const now = new Date('2026-11-01T12:00:00.000Z');

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id: 'entry-alpha',
        sourceText: 'Alpha source',
        normalizedSource: 'alpha source',
        translatedText: 'Alpha translation',
        sourceLanguage: 'en-US',
        targetLanguage: 'zh-CN',
        occurrenceCount: 5,
        recentOccurrenceCount: 4,
        translationCount: 5,
        firstSeenAt: '2026-10-20T12:00:00.000Z',
        lastUsedAt: '2026-11-01T11:00:00.000Z',
        context: 'At the café counter',
        quizIntervalDays: 1,
        nextDueAt: '2026-11-02T12:00:00.000Z',
        ...overrides
    };
}

function makeStatistic(overrides: Partial<HeatStatistic> = {}): HeatStatistic {
    return {
        sourceText: 'Alpha source',
        normalizedSource: 'alpha source',
        translatedText: 'Alpha translation',
        sourceLanguage: 'en-US',
        targetLanguage: 'zh-CN',
        occurrenceCount: 5,
        recentOccurrenceCount: 4,
        lastUsedAt: '2026-11-01T11:00:00.000Z',
        ...overrides
    };
}

function entriesFixture(): MemoryEntry[] {
    return [
        makeEntry(),
        makeEntry({
            id: 'entry-beta',
            sourceText: 'Beta source',
            normalizedSource: 'beta source',
            translatedText: 'Beta translation',
            sourceLanguage: 'en-US',
            targetLanguage: 'fr-FR',
            occurrenceCount: 3,
            recentOccurrenceCount: 1,
            translationCount: 3,
            firstSeenAt: '2026-10-15T12:00:00.000Z',
            lastUsedAt: '2026-10-22T12:00:00.000Z',
            context: 'In the library',
            quizIntervalDays: 3,
            nextDueAt: '2026-11-03T12:00:00.000Z'
        }),
        makeEntry({
            id: 'entry-gamma',
            sourceText: 'Gamma source',
            normalizedSource: 'gamma source',
            translatedText: 'Gamma translation',
            sourceLanguage: 'ja-JP',
            targetLanguage: 'en-US',
            occurrenceCount: 2,
            recentOccurrenceCount: 0,
            translationCount: 2,
            firstSeenAt: '2026-09-15T12:00:00.000Z',
            lastUsedAt: '2026-09-22T12:00:00.000Z',
            context: 'On the train',
            quizIntervalDays: 7,
            nextDueAt: '2026-11-04T12:00:00.000Z'
        })
    ];
}

function statisticsFixture(): HeatStatistic[] {
    return entriesFixture().map((entry) => makeStatistic({
        sourceText: entry.sourceText,
        normalizedSource: entry.normalizedSource,
        translatedText: entry.translatedText,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        occurrenceCount: entry.occurrenceCount,
        recentOccurrenceCount: entry.recentOccurrenceCount,
        lastUsedAt: entry.lastUsedAt
    }));
}

function preferencesFixture(): SettingsPreferences {
    return {
        hotkey: 'Ctrl+Shift+T',
        privacy: {
            localOnly: true,
            saveTranslationHistory: true,
            restoreClipboard: true
        },
        performance: {
            reduceMotion: false,
            pauseWhenFullscreen: true,
            limitFrameRate: true
        }
    };
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('VocabularyHeatView', () => {
    it('renders ranked entries and accessible frequency trends', () => {
        render(
            <VocabularyHeatView
                statistics={[
                    makeStatistic({ occurrenceCount: 4, recentOccurrenceCount: 2 }),
                    makeStatistic({
                        normalizedSource: 'beta source',
                        sourceText: 'Beta source',
                        translatedText: 'Beta translation',
                        occurrenceCount: 5,
                        recentOccurrenceCount: 4
                    }),
                    makeStatistic({
                        normalizedSource: 'gamma source',
                        sourceText: 'Gamma source',
                        translatedText: 'Gamma translation',
                        occurrenceCount: 2,
                        recentOccurrenceCount: 0
                    })
                ]}
                entries={entriesFixture()}
                now={now}
            />
        );

        const table = screen.getByRole('table', { name: 'Vocabulary heat' });
        const rows = within(table).getAllByRole('row').slice(1);
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining('Beta source'),
            expect.stringContaining('Alpha source'),
            expect.stringContaining('Gamma source')
        ]);
        expect(screen.getAllByText('Rising').length).toBeGreaterThan(0);
        expect(screen.getByLabelText('Frequency trend for Beta source').getAttribute('aria-valuenow'))
            .toBe('80');
    });

    it('filters by 7-day, 30-day, all-time, and language pair', async () => {
        const user = userEvent.setup();
        const filterHeat = vi.fn();
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                actions={{ filterHeat }}
            />
        );

        await user.click(screen.getByRole('button', { name: '7 days' }));
        expect(screen.getByText('Alpha source')).toBeDefined();
        expect(screen.queryByText('Beta source')).toBeNull();
        expect(filterHeat).toHaveBeenLastCalledWith({
            range: '7d',
            sourceLanguage: '',
            targetLanguage: ''
        });

        await user.click(screen.getByRole('button', { name: '30 days' }));
        expect(screen.getByText('Beta source')).toBeDefined();
        expect(screen.queryByText('Gamma source')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'All time' }));
        expect(screen.getByText('Gamma source')).toBeDefined();

        await user.selectOptions(screen.getByLabelText('Source language'), 'ja-JP');
        await user.selectOptions(screen.getByLabelText('Target language'), 'en-US');
        expect(screen.getByText('Gamma source')).toBeDefined();
        expect(screen.queryByText('Alpha source')).toBeNull();
        expect(filterHeat).toHaveBeenLastCalledWith({
            range: 'all',
            sourceLanguage: 'ja-JP',
            targetLanguage: 'en-US'
        });
    });

    it('debounces search while filtering rendered history', async () => {
        vi.useFakeTimers();
        const searchEntries = vi.fn();
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                actions={{ searchEntries }}
            />
        );

        fireEvent.change(screen.getByLabelText('Search vocabulary'), {
            target: { value: 'library' }
        });
        expect(screen.queryByText('Alpha source')).toBeNull();
        expect(screen.getByText('Beta source')).toBeDefined();
        expect(searchEntries).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(searchEntries).toHaveBeenCalledExactlyOnceWith('library');
    });

    it('opens context and navigates between entries', async () => {
        const user = userEvent.setup();
        const openContext = vi.fn();
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                actions={{ openContext }}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Open Alpha source context' }));
        expect(screen.getByRole('dialog', { name: 'Vocabulary context' }).textContent)
            .toContain('At the café counter');
        expect(openContext).toHaveBeenCalledWith('entry-alpha');
        await user.click(screen.getByRole('button', { name: 'Next entry' }));
        expect(screen.getByRole('dialog', { name: 'Vocabulary context' }).textContent)
            .toContain('In the library');
        expect(openContext).toHaveBeenLastCalledWith('entry-beta');
    });

    it('edits an entry through the public action and renders the update', async () => {
        const user = userEvent.setup();
        const editEntry = vi.fn(async (id: string, patch: VocabularyEntryPatch) => {
            expect(id).toBe('entry-alpha');
            expect(patch).toEqual({ translatedText: 'Corrected translation' });
        });
        function Harness(): React.JSX.Element {
            const [entries, setEntries] = useState(entriesFixture());
            return (
                <VocabularyHeatView
                    statistics={statisticsFixture()}
                    entries={entries}
                    now={now}
                    actions={{
                        editEntry: async (id, patch) => {
                            await editEntry(id, patch);
                            setEntries((current) => current.map((entry) => (
                                entry.id === id ? { ...entry, ...patch } : entry
                            )));
                        }
                    }}
                />
            );
        }
        render(<Harness />);

        await user.click(screen.getByRole('button', { name: 'Edit Alpha source' }));
        await user.clear(screen.getByLabelText('Translation'));
        await user.type(screen.getByLabelText('Translation'), 'Corrected translation');
        await user.click(screen.getByRole('button', { name: 'Save entry' }));
        await waitFor(() => expect(screen.getByText('Corrected translation')).toBeDefined());
        expect(editEntry).toHaveBeenCalledOnce();
    });

    it('requires explicit confirmation before deleting an entry', async () => {
        const user = userEvent.setup();
        const deleteEntry = vi.fn();
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                actions={{ deleteEntry }}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Delete Alpha source' }));
        expect(screen.getByRole('dialog', { name: 'Delete vocabulary entry' }).textContent)
            .toContain('Delete this vocabulary entry');
        expect(deleteEntry).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await user.click(screen.getByRole('button', { name: 'Delete Alpha source' }));
        await user.click(screen.getByRole('button', { name: 'Delete entry' }));
        expect(deleteEntry).toHaveBeenCalledWith('entry-alpha');
    });

    it('exports vocabulary history as CSV and JSON', async () => {
        const user = userEvent.setup();
        const downloadNames: string[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement
        ) {
            downloadNames.push(this.download);
        });
        const exportEntries = vi.fn(async (format: 'csv' | 'json') => (
            buildVocabularyExport(entriesFixture(), format)
        ));
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                actions={{ exportEntries }}
            />
        );

        const csv = buildVocabularyExport(entriesFixture(), 'csv');
        expect(csv.split('\r\n')[0]).toBe(
            'id,source_text,normalized_source,translated_text,source_language,target_language,occurrence_count,recent_occurrence_count,translation_count,first_seen_at,last_used_at,context,quiz_interval_days,next_due_at'
        );
        expect(csv).toContain('"Alpha source"');

        const json = JSON.parse(buildVocabularyExport(entriesFixture(), 'json')) as MemoryEntry[];
        expect(json).toHaveLength(3);
        expect(json[0]).toMatchObject({ id: 'entry-alpha', sourceText: 'Alpha source' });

        await user.click(screen.getByRole('button', { name: 'Export CSV' }));
        await user.click(screen.getByRole('button', { name: 'Export JSON' }));
        expect(exportEntries).toHaveBeenNthCalledWith(1, 'csv');
        expect(exportEntries).toHaveBeenNthCalledWith(2, 'json');
        await waitFor(() => expect(downloadNames).toEqual([
            'vocabulary.csv',
            'vocabulary.json'
        ]));
    });

    it('toggles paused vocabulary memory through the public action', async () => {
        const user = userEvent.setup();
        const toggleMemory = vi.fn();
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                actions={{ toggleMemory }}
            />
        );

        expect(screen.getByRole('status', { name: 'Vocabulary memory status' }).textContent)
            .toContain('Vocabulary memory active');
        await user.click(screen.getByLabelText('Pause vocabulary memory'));
        expect(toggleMemory).toHaveBeenCalledWith(true);
        expect(screen.getByRole('status', { name: 'Vocabulary memory status' }).textContent)
            .toContain('Vocabulary memory paused');
        await user.click(screen.getByLabelText('Pause vocabulary memory'));
        expect(toggleMemory).toHaveBeenLastCalledWith(false);
    });

    it('shows local-only privacy status and pause controls in settings', async () => {
        const user = userEvent.setup();
        const toggleMemory = vi.fn();
        render(
            <SettingsWindow
                providers={[]}
                activeProviderId=""
                preferences={preferencesFixture()}
                vocabulary={{
                    statistics: statisticsFixture(),
                    entries: entriesFixture(),
                    now,
                    actions: { toggleMemory }
                }}
            />
        );

        expect(screen.getByRole('status', { name: 'Vocabulary privacy' }).textContent)
            .toContain('Local-only');
        await user.click(screen.getByLabelText('Pause vocabulary memory'));
        expect(toggleMemory).toHaveBeenCalledWith(true);
    });

    it('virtualizes long rows while preserving accessible table positions', () => {
        const entries = Array.from({ length: 200 }, (_, index) => makeEntry({
            id: `entry-${index + 1}`,
            sourceText: `Row ${index + 1} source`,
            normalizedSource: `row ${index + 1} source`,
            translatedText: `Row ${index + 1} translation`,
            firstSeenAt: '2026-10-01T12:00:00.000Z',
            lastUsedAt: '2026-11-01T11:00:00.000Z',
            context: `Context ${index + 1}`,
            quizIntervalDays: 1,
            nextDueAt: '2026-11-02T12:00:00.000Z'
        }));
        render(
            <VocabularyHeatView
                statistics={[]}
                entries={entries}
                now={now}
                virtualization={{ rowHeight: 32, viewportHeight: 320 }}
            />
        );

        const table = screen.getByRole('table', { name: 'Vocabulary heat' });
        expect(table.getAttribute('aria-rowcount')).toBe('201');
        expect(table.getAttribute('aria-colcount')).toBe('8');
        const renderedRows = within(table).getAllByRole('row');
        expect(renderedRows.length).toBeGreaterThan(1);
        expect(renderedRows.length).toBeLessThan(30);
        expect(renderedRows.some((row) => row.getAttribute('aria-rowindex') === '2')).toBe(true);

        fireEvent.scroll(screen.getByRole('region', { name: 'Vocabulary rows' }), {
            target: { scrollTop: 100_000 }
        });
        expect(within(table).getAllByRole('row').some((row) => (
            row.getAttribute('aria-rowindex') === '201'
        ))).toBe(true);
    });
});
