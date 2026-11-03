// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsWindow from '../../src/renderer/settings/SettingsWindow';
import {
    VocabularyHeatView
} from '../../src/renderer/learning/VocabularyHeatView';
import type {
    HeatStatistic,
    MemoryEntry,
    MemoryEntryPatch,
    SettingsPreferences,
    VocabularyRepositoryFacade
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

function repositoryFixture(overrides: Partial<VocabularyRepositoryFacade> = {}): VocabularyRepositoryFacade {
    return {
        queryHeat: vi.fn(async () => statisticsFixture()),
        listEntries: vi.fn(async () => entriesFixture()),
        getMemoryEnabled: vi.fn(async () => true),
        updateEntry: vi.fn(async () => undefined),
        deleteEntries: vi.fn(async () => undefined),
        exportEntries: vi.fn(async () => ''),
        setMemoryEnabled: vi.fn(async () => undefined),
        ...overrides
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
                        sourceLanguage: 'en-US',
                        targetLanguage: 'fr-FR',
                        occurrenceCount: 5,
                        recentOccurrenceCount: 4
                    }),
                    makeStatistic({
                        normalizedSource: 'gamma source',
                        sourceText: 'Gamma source',
                        translatedText: 'Gamma translation',
                        sourceLanguage: 'ja-JP',
                        targetLanguage: 'en-US',
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

    it('reports asynchronous search and filter failures', async () => {
        const searchEntries = vi.fn(async () => {
            throw new Error('Search failed.');
        });
        const filterHeat = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('Filter failed.'));
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                actions={{ filterHeat, searchEntries }}
            />
        );

        fireEvent.change(screen.getByLabelText('Search vocabulary'), {
            target: { value: 'library' }
        });
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(
            'Search failed.'
        ));
        fireEvent.click(screen.getByRole('button', { name: '7 days' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(
            'Filter failed.'
        ));
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
        const editEntry = vi.fn(async (id: string, patch: MemoryEntryPatch) => {
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
        const json = JSON.stringify({
            version: 1,
            exportedAt: '2026-11-01T12:00:00.000Z',
            entries: entriesFixture()
        }, null, 2);
        const csv = [
            'id,sourceText,normalizedSource,translatedText,sourceLanguage,targetLanguage,occurrenceCount,recentOccurrenceCount,translationCount,firstSeenAt,lastUsedAt,context,quizIntervalDays,nextDueAt',
            '"entry-alpha","Alpha source","alpha source","Alpha translation","en-US","zh-CN",5,4,5,"2026-10-20T12:00:00.000Z","2026-11-01T11:00:00.000Z","At the café counter",1,"2026-11-02T12:00:00.000Z"',
            ''
        ].join('\n');
        const exportEntries = vi.fn(async (format: 'csv' | 'json') => (
            format === 'csv' ? csv : json
        ));
        const repository = repositoryFixture({ exportEntries });
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                repository={repository}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Export CSV' }));
        await user.click(screen.getByRole('button', { name: 'Export JSON' }));
        expect(exportEntries).toHaveBeenNthCalledWith(1, 'csv');
        expect(exportEntries).toHaveBeenNthCalledWith(2, 'json');
        await expect(exportEntries.mock.results[0]?.value).resolves.toBe(csv);
        await expect(exportEntries.mock.results[1]?.value).resolves.toBe(json);
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
        const setMemoryEnabled = vi.fn(async () => undefined);
        const preferences = preferencesFixture();
        preferences.privacy.saveTranslationHistory = false;
        render(
            <SettingsWindow
                providers={[]}
                activeProviderId=""
                preferences={preferences}
                vocabularyRepository={repositoryFixture({
                    getMemoryEnabled: vi.fn(async () => true),
                    setMemoryEnabled
                })}
            />
        );

        expect(screen.getByRole('status', { name: 'Vocabulary privacy' }).textContent)
            .toContain('Local-only');
        expect(screen.getByLabelText('Pause vocabulary memory')).toHaveProperty('checked', false);
        await user.click(screen.getByLabelText('Pause vocabulary memory'));
        expect(setMemoryEnabled).toHaveBeenCalledWith(false);
    });

    it('restores persisted memory pause state on remount instead of preferences', async () => {
        const getMemoryEnabled = vi.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const firstPreferences = preferencesFixture();
        firstPreferences.privacy.saveTranslationHistory = false;
        const first = render(
            <SettingsWindow
                providers={[]}
                activeProviderId=""
                preferences={firstPreferences}
                vocabularyRepository={repositoryFixture({ getMemoryEnabled })}
            />
        );
        await waitFor(() => expect(
            screen.getByLabelText('Pause vocabulary memory')
        ).toHaveProperty('checked', false));
        first.unmount();

        const secondPreferences = preferencesFixture();
        secondPreferences.privacy.saveTranslationHistory = true;
        render(
            <SettingsWindow
                providers={[]}
                activeProviderId=""
                preferences={secondPreferences}
                vocabularyRepository={repositoryFixture({ getMemoryEnabled })}
            />
        );
        await waitFor(() => expect(
            screen.getByLabelText('Pause vocabulary memory')
        ).toHaveProperty('checked', true));
        expect(screen.getByRole('status', { name: 'Vocabulary memory status' }).textContent)
            .toContain('Vocabulary memory paused');
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
        expect(table.tagName).toBe('TABLE');
        expect((table as HTMLTableElement).style.tableLayout).toBe('fixed');
        expect(table.getAttribute('aria-rowcount')).toBe('201');
        expect(table.getAttribute('aria-colcount')).toBe('8');
        const renderedRows = within(table).getAllByRole('row');
        expect(renderedRows.length).toBeGreaterThan(1);
        expect(renderedRows.length).toBeLessThan(30);
        expect(renderedRows.some((row) => row.getAttribute('aria-rowindex') === '2')).toBe(true);
        expect(renderedRows[1]?.style.height).toBe('32px');
        expect((within(table).getAllByRole('cell')[0] as HTMLElement).style.overflow).toBe('hidden');

        fireEvent.scroll(screen.getByRole('region', { name: 'Vocabulary rows' }), {
            target: { scrollTop: 100_000 }
        });
        expect(within(table).getAllByRole('row').some((row) => (
            row.getAttribute('aria-rowindex') === '201'
        ))).toBe(true);
    });

    it('keeps exact language-pair identities separate and ranks unmatched rows', () => {
        const entries = [
            makeEntry({
                id: 'entry-en',
                sourceText: 'Hello',
                normalizedSource: 'hello',
                translatedText: '你好',
                sourceLanguage: 'en-US',
                targetLanguage: 'zh-CN',
                occurrenceCount: 5,
                recentOccurrenceCount: 5
            }),
            makeEntry({
                id: 'entry-fr',
                sourceText: 'Hello',
                normalizedSource: 'hello',
                translatedText: 'Bonjour',
                sourceLanguage: 'fr-FR',
                targetLanguage: 'en-US',
                occurrenceCount: 3,
                recentOccurrenceCount: 3
            }),
            makeEntry({
                id: 'entry-extra',
                sourceText: 'Extra',
                normalizedSource: 'extra',
                translatedText: 'Extra translation',
                sourceLanguage: 'en-US',
                targetLanguage: 'de-DE',
                occurrenceCount: 1,
                recentOccurrenceCount: 1
            })
        ];
        const statistics = [
            makeStatistic({
                sourceText: 'Hello',
                normalizedSource: 'hello',
                translatedText: '你好',
                sourceLanguage: 'en-US',
                targetLanguage: 'zh-CN',
                occurrenceCount: 5,
                recentOccurrenceCount: 5
            }),
            makeStatistic({
                sourceText: 'Hello',
                normalizedSource: 'hello',
                translatedText: 'Bonjour',
                sourceLanguage: 'fr-FR',
                targetLanguage: 'en-US',
                occurrenceCount: 3,
                recentOccurrenceCount: 3
            }),
            makeStatistic({
                sourceText: 'Missing',
                normalizedSource: 'missing',
                translatedText: 'Missing translation',
                sourceLanguage: 'en-US',
                targetLanguage: 'it-IT',
                occurrenceCount: 6,
                recentOccurrenceCount: 6
            })
        ];

        const { rerender } = render(
            <VocabularyHeatView statistics={statistics} entries={entries} now={now} />
        );
        const firstOrder = within(screen.getByRole('table'))
            .getAllByRole('row')
            .slice(1)
            .map((row) => row.textContent);
        expect(firstOrder.map((value) => value?.includes('Missing translation'))).toEqual([
            true,
            false,
            false,
            false
        ]);
        expect(screen.getAllByText('你好')).toHaveLength(1);
        expect(screen.getAllByText('Bonjour')).toHaveLength(1);
        expect(screen.getAllByText('Entry-only').length).toBe(1);
        expect(screen.getAllByText('Statistic-only').length).toBe(1);

        rerender(
            <VocabularyHeatView
                statistics={[...statistics].reverse()}
                entries={[...entries].reverse()}
                now={now}
            />
        );
        expect(within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) => (
            row.textContent
        ))).toEqual(firstOrder);
    });

    it('maps the complete repository edit patch surface', async () => {
        const user = userEvent.setup();
        const updateEntry = vi.fn(async () => undefined);
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                repository={repositoryFixture({ updateEntry })}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Edit Alpha source' }));
        const dialog = within(screen.getByRole('dialog'));
        await user.clear(dialog.getByLabelText('Source text'));
        await user.type(dialog.getByLabelText('Source text'), 'Alpha edited');
        await user.clear(dialog.getByLabelText('Translation'));
        await user.type(dialog.getByLabelText('Translation'), 'Corrected translation');
        await user.clear(dialog.getByLabelText('Source language'));
        await user.type(dialog.getByLabelText('Source language'), 'en-GB');
        await user.clear(dialog.getByLabelText('Target language'));
        await user.type(dialog.getByLabelText('Target language'), 'fr-FR');
        await user.clear(dialog.getByLabelText('Context'));
        await user.type(dialog.getByLabelText('Context'), 'Updated context');
        await user.clear(dialog.getByLabelText('Quiz interval days'));
        await user.type(dialog.getByLabelText('Quiz interval days'), '7');
        await user.clear(dialog.getByLabelText('Next due at (ISO)'));
        await user.type(dialog.getByLabelText('Next due at (ISO)'), '2026-11-09T09:30:00.000Z');
        await user.click(screen.getByRole('button', { name: 'Save entry' }));

        await waitFor(() => expect(updateEntry).toHaveBeenCalledWith('entry-alpha', {
            sourceText: 'Alpha edited',
            translatedText: 'Corrected translation',
            sourceLanguage: 'en-GB',
            targetLanguage: 'fr-FR',
            context: 'Updated context',
            quizIntervalDays: 7,
            nextDueAt: '2026-11-09T09:30:00.000Z'
        }));
    });

    it('rolls back failed pause state and keeps failed edits open', async () => {
        const user = userEvent.setup();
        const repository = repositoryFixture({
            updateEntry: vi.fn(async () => {
                throw new Error('Update failed.');
            }),
            setMemoryEnabled: vi.fn(async () => {
                throw new Error('Pause failed.');
            })
        });
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                repository={repository}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Edit Alpha source' }));
        await user.clear(screen.getByLabelText('Translation'));
        await user.type(screen.getByLabelText('Translation'), 'Rejected');
        await user.click(screen.getByRole('button', { name: 'Save entry' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Update failed.'));
        expect(screen.getByRole('dialog', { name: 'Edit vocabulary entry' })).toBeDefined();

        await user.click(screen.getByLabelText('Pause vocabulary memory'));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Pause failed.'));
        expect(screen.getByLabelText('Pause vocabulary memory')).toHaveProperty('checked', false);
    });

    it('ignores stale async edit results after the dialog changes', async () => {
        const user = userEvent.setup();
        let resolveFirst: (() => void) | undefined;
        const updateEntry = vi.fn()
            .mockImplementationOnce(() => new Promise<void>((resolve) => {
                resolveFirst = resolve;
            }))
            .mockResolvedValue(undefined);
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
                repository={repositoryFixture({ updateEntry })}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Edit Alpha source' }));
        await user.clear(screen.getByLabelText('Translation'));
        await user.type(screen.getByLabelText('Translation'), 'First update');
        await user.click(screen.getByRole('button', { name: 'Save entry' }));
        await user.click(screen.getByRole('button', { name: 'Edit Beta source' }));
        resolveFirst?.();

        await waitFor(() => expect(updateEntry).toHaveBeenCalledOnce());
        expect(screen.getByRole('dialog', { name: 'Edit vocabulary entry' })).toBeDefined();
        expect(screen.getByLabelText('Translation')).toHaveProperty('value', 'Beta translation');
    });

    it('refreshes repository rows after delete and ignores late loads after unmount', async () => {
        const user = userEvent.setup();
        let resolveQuery: (() => void) | undefined;
        const lateRepository = repositoryFixture({
            listEntries: vi.fn(async () => []),
            queryHeat: vi.fn(() => new Promise((resolve) => {
                resolveQuery = () => resolve(statisticsFixture());
            }))
        });
        const view = render(
            <VocabularyHeatView
                statistics={[]}
                entries={[]}
                now={now}
                repository={lateRepository}
            />
        );
        view.unmount();
        resolveQuery?.();

        const listEntries = vi.fn()
            .mockResolvedValueOnce(entriesFixture())
            .mockResolvedValue(entriesFixture().filter((entry) => entry.id !== 'entry-alpha'));
        const repository = repositoryFixture({
            queryHeat: vi.fn()
                .mockResolvedValueOnce(statisticsFixture())
                .mockResolvedValue(statisticsFixture().filter((item) => (
                    item.normalizedSource !== 'alpha source'
                ))),
            listEntries,
            deleteEntries: vi.fn(async () => undefined)
        });
        const refreshed = render(
            <VocabularyHeatView
                statistics={[]}
                entries={[]}
                now={now}
                repository={repository}
            />
        );
        await screen.findByRole('button', { name: 'Delete Alpha source' });
        await user.click(screen.getByRole('button', { name: 'Delete Alpha source' }));
        await user.click(screen.getByRole('button', { name: 'Delete entry' }));
        await waitFor(() => expect(screen.queryByText('Alpha source')).toBeNull());
        expect(repository.deleteEntries).toHaveBeenCalledWith(['entry-alpha']);
        expect(listEntries.mock.calls.length).toBeGreaterThanOrEqual(2);
        refreshed.unmount();
    });

    it('disables unsupported history controls when the action set is incomplete', () => {
        render(
            <VocabularyHeatView
                statistics={statisticsFixture()}
                entries={entriesFixture()}
                now={now}
            />
        );

        for (const name of [
            'Open Alpha source context',
            'Edit Alpha source',
            'Delete Alpha source',
            'Export CSV',
            'Export JSON'
        ]) {
            expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
        }
        expect(screen.getByLabelText('Pause vocabulary memory')).toHaveProperty('disabled', true);
    });
});
