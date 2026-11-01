import { useEffect, useMemo, useState } from 'react';
import type { HeatStatistic, MemoryEntry } from '../../shared/contracts';

export type VocabularyExportFormat = 'csv' | 'json';

export type VocabularyTimeRange = '7d' | '30d' | 'all';

export interface VocabularyHeatFilter {
    range: VocabularyTimeRange;
    sourceLanguage: string;
    targetLanguage: string;
}

export interface VocabularyEntryPatch {
    translatedText: string;
}

export interface VocabularyUiActions {
    searchEntries?: (query: string) => Promise<void> | void;
    filterHeat?: (filter: VocabularyHeatFilter) => Promise<void> | void;
    openContext?: (entryId: string) => Promise<void> | void;
    editEntry?: (
        entryId: string,
        patch: VocabularyEntryPatch
    ) => Promise<void> | void;
    deleteEntry?: (entryId: string) => Promise<void> | void;
    exportEntries?: (
        format: VocabularyExportFormat
    ) => Promise<string | undefined> | string | undefined | void;
    toggleMemory?: (paused: boolean) => Promise<void> | void;
}

export interface VocabularyVirtualizationOptions {
    rowHeight?: number;
    viewportHeight?: number;
    overscan?: number;
}

export interface VocabularyHeatViewProps {
    statistics: readonly HeatStatistic[];
    entries?: readonly MemoryEntry[];
    now?: Date;
    actions?: VocabularyUiActions;
    memoryPaused?: boolean;
    privacyLocalOnly?: boolean;
    virtualization?: VocabularyVirtualizationOptions;
}

interface VocabularyRow {
    key: string;
    entryId?: string;
    sourceText: string;
    normalizedSource: string;
    translatedText: string;
    sourceLanguage: string;
    targetLanguage: string;
    occurrenceCount: number;
    recentOccurrenceCount: number;
    lastUsedAt: string;
    context: string;
}

type VocabularyDialog =
    | { kind: 'context'; entryId: string }
    | { kind: 'edit'; entryId: string }
    | { kind: 'delete'; entryId: string };

function compareText(left: string, right: string): number {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}

export function rankHeatStatistics(
    statistics: readonly HeatStatistic[]
): HeatStatistic[] {
    return [...statistics].sort((left, right) => (
        right.occurrenceCount - left.occurrenceCount
        || right.recentOccurrenceCount - left.recentOccurrenceCount
        || compareText(right.lastUsedAt, left.lastUsedAt)
        || compareText(left.normalizedSource, right.normalizedSource)
        || compareText(left.sourceLanguage, right.sourceLanguage)
        || compareText(left.targetLanguage, right.targetLanguage)
    ));
}

function csvCell(value: string | number): string {
    return `"${String(value).replaceAll('"', '""')}"`;
}

export function buildVocabularyExport(
    entries: readonly MemoryEntry[],
    format: VocabularyExportFormat
): string {
    if (format === 'json')
        return JSON.stringify(entries, null, 2);

    const columns = [
        'id',
        'source_text',
        'normalized_source',
        'translated_text',
        'source_language',
        'target_language',
        'occurrence_count',
        'recent_occurrence_count',
        'translation_count',
        'first_seen_at',
        'last_used_at',
        'context',
        'quiz_interval_days',
        'next_due_at'
    ] as const;
    const rows = entries.map((entry) => [
        entry.id,
        entry.sourceText,
        entry.normalizedSource,
        entry.translatedText,
        entry.sourceLanguage,
        entry.targetLanguage,
        entry.occurrenceCount,
        entry.recentOccurrenceCount,
        entry.translationCount,
        entry.firstSeenAt,
        entry.lastUsedAt,
        entry.context,
        entry.quizIntervalDays,
        entry.nextDueAt
    ].map(csvCell).join(','));
    return [columns.join(','), ...rows].join('\r\n');
}

function entryKey(value: {
    normalizedSource: string;
    sourceLanguage: string;
    targetLanguage: string;
}): string {
    return `${value.normalizedSource}:${value.sourceLanguage}:${value.targetLanguage}`;
}

function findEntry(
    entries: readonly MemoryEntry[],
    statistic: HeatStatistic
): MemoryEntry | undefined {
    const exact = entries.find((entry) => entryKey(entry) === entryKey(statistic));
    if (exact !== undefined)
        return exact;
    return entries.find((entry) => (
        entry.normalizedSource === statistic.normalizedSource
    ));
}

function buildRows(
    statistics: readonly HeatStatistic[],
    entries: readonly MemoryEntry[]
): VocabularyRow[] {
    const matchedEntryIds = new Set<string>();
    const statisticRows = rankHeatStatistics(statistics).map((statistic) => {
        const entry = findEntry(entries, statistic);
        if (entry !== undefined)
            matchedEntryIds.add(entry.id);
        return {
            key: entry === undefined ? entryKey(statistic) : `entry:${entry.id}`,
            ...(entry === undefined ? {} : { entryId: entry.id }),
            sourceText: entry?.sourceText ?? statistic.sourceText,
            normalizedSource: entry?.normalizedSource ?? statistic.normalizedSource,
            translatedText: entry?.translatedText ?? statistic.translatedText,
            sourceLanguage: entry?.sourceLanguage ?? statistic.sourceLanguage,
            targetLanguage: entry?.targetLanguage ?? statistic.targetLanguage,
            occurrenceCount: statistic.occurrenceCount,
            recentOccurrenceCount: statistic.recentOccurrenceCount,
            lastUsedAt: entry?.lastUsedAt ?? statistic.lastUsedAt,
            context: entry?.context ?? ''
        };
    });
    const entryRows = entries.filter((entry) => !matchedEntryIds.has(entry.id)).map((entry) => ({
        key: `entry:${entry.id}`,
        entryId: entry.id,
        sourceText: entry.sourceText,
        normalizedSource: entry.normalizedSource,
        translatedText: entry.translatedText,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        occurrenceCount: entry.occurrenceCount,
        recentOccurrenceCount: entry.recentOccurrenceCount,
        lastUsedAt: entry.lastUsedAt,
        context: entry.context
    }));
    return [...statisticRows, ...entryRows];
}

function normalizedSearch(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function matchesSearch(row: VocabularyRow, query: string): boolean {
    const normalizedQuery = normalizedSearch(query);
    if (normalizedQuery.length === 0)
        return true;
    return [
        row.sourceText,
        row.normalizedSource,
        row.translatedText,
        row.context
    ].some((value) => normalizedSearch(value).includes(normalizedQuery));
}

function isWithinRange(lastUsedAt: string, range: VocabularyTimeRange, now: Date): boolean {
    if (range === 'all')
        return true;
    const days = range === '7d' ? 7 : 30;
    const timestamp = Date.parse(lastUsedAt);
    return Number.isFinite(timestamp)
        && timestamp >= now.getTime() - days * 24 * 60 * 60 * 1000;
}

function trendFor(row: VocabularyRow): { label: string; value: number } {
    const value = row.occurrenceCount === 0
        ? 0
        : Math.round(row.recentOccurrenceCount / row.occurrenceCount * 100);
    if (value >= 50)
        return { label: 'Rising', value };
    if (value > 0)
        return { label: 'Steady', value };
    return { label: 'Cooling', value };
}

function downloadVocabularyExport(
    content: string,
    format: VocabularyExportFormat
): void {
    const mimeType = format === 'csv'
        ? 'text/csv;charset=utf-8'
        : 'application/json;charset=utf-8';
    const blob = new Blob([content], { type: mimeType });
    const hasObjectUrl = typeof URL.createObjectURL === 'function';
    const href = hasObjectUrl
        ? URL.createObjectURL(blob)
        : `data:${mimeType},${encodeURIComponent(content)}`;
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `vocabulary.${format}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (hasObjectUrl)
        URL.revokeObjectURL(href);
}

export function VocabularyHeatView({
    statistics,
    entries = [],
    now = new Date(),
    actions,
    memoryPaused: providedMemoryPaused = false,
    privacyLocalOnly = true,
    virtualization
}: VocabularyHeatViewProps): React.JSX.Element {
    const [filter, setFilter] = useState<VocabularyHeatFilter>({
        range: 'all',
        sourceLanguage: '',
        targetLanguage: ''
    });
    const [searchDraft, setSearchDraft] = useState('');
    const [dialog, setDialog] = useState<VocabularyDialog>();
    const [translationDraft, setTranslationDraft] = useState('');
    const [memoryPaused, setMemoryPaused] = useState(providedMemoryPaused);
    const [scrollTop, setScrollTop] = useState(0);

    const rowHeight = virtualization?.rowHeight ?? 32;
    const viewportHeight = virtualization?.viewportHeight ?? 320;
    const overscan = virtualization?.overscan ?? 4;
    const historyMode = entries.length > 0;
    const rows = useMemo(() => buildRows(statistics, entries), [statistics, entries]);
    const entryRows = useMemo(() => entries.map((entry) => ({
        key: `entry:${entry.id}`,
        entryId: entry.id,
        sourceText: entry.sourceText,
        normalizedSource: entry.normalizedSource,
        translatedText: entry.translatedText,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        occurrenceCount: entry.occurrenceCount,
        recentOccurrenceCount: entry.recentOccurrenceCount,
        lastUsedAt: entry.lastUsedAt,
        context: entry.context
    })), [entries]);
    const filteredRows = useMemo(() => rows.filter((row) => (
        isWithinRange(row.lastUsedAt, filter.range, now)
        && (filter.sourceLanguage.length === 0
            || row.sourceLanguage === filter.sourceLanguage)
        && (filter.targetLanguage.length === 0
            || row.targetLanguage === filter.targetLanguage)
        && matchesSearch(row, searchDraft)
    )), [rows, filter, now, searchDraft]);
    const sourceLanguages = useMemo(() => (
        [...new Set(rows.map((row) => row.sourceLanguage))].sort(compareText)
    ), [rows]);
    const targetLanguages = useMemo(() => (
        [...new Set(rows.map((row) => row.targetLanguage))].sort(compareText)
    ), [rows]);
    const visibleRowCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
    const startRow = Math.max(0, Math.min(
        Math.floor(scrollTop / rowHeight) - overscan,
        Math.max(0, filteredRows.length - visibleRowCount)
    ));
    const visibleRows = filteredRows.slice(startRow, startRow + visibleRowCount);
    const currentEntryIndex = dialog === undefined
        ? -1
        : entryRows.findIndex((row) => row.entryId === dialog.entryId);
    const currentEntry = currentEntryIndex < 0 ? undefined : entryRows[currentEntryIndex];

    useEffect(() => {
        setMemoryPaused(providedMemoryPaused);
    }, [providedMemoryPaused]);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void actions?.searchEntries?.(searchDraft);
        }, 300);
        return () => window.clearTimeout(timeout);
    }, [actions, searchDraft]);

    useEffect(() => {
        void actions?.filterHeat?.(filter);
    }, [actions, filter]);

    const updateFilter = (patch: Partial<VocabularyHeatFilter>): void => {
        setFilter((current) => ({ ...current, ...patch }));
    };

    const openEdit = (row: VocabularyRow): void => {
        if (row.entryId === undefined)
            return;
        setTranslationDraft(row.translatedText);
        setDialog({ kind: 'edit', entryId: row.entryId });
    };

    const saveEdit = async (): Promise<void> => {
        if (dialog?.kind !== 'edit')
            return;
        await actions?.editEntry?.(dialog.entryId, {
            translatedText: translationDraft
        });
        setDialog(undefined);
    };

    const confirmDelete = async (): Promise<void> => {
        if (dialog?.kind !== 'delete')
            return;
        await actions?.deleteEntry?.(dialog.entryId);
        setDialog(undefined);
    };

    const navigateContext = (offset: -1 | 1): void => {
        const nextIndex = currentEntryIndex + offset;
        const nextEntry = entryRows[nextIndex];
        if (nextEntry?.entryId === undefined)
            return;
        setDialog({ kind: 'context', entryId: nextEntry.entryId });
        void actions?.openContext?.(nextEntry.entryId);
    };

    const toggleMemory = (paused: boolean): void => {
        setMemoryPaused(paused);
        void actions?.toggleMemory?.(paused);
    };

    const exportVocabulary = async (format: VocabularyExportFormat): Promise<void> => {
        const content = await actions?.exportEntries?.(format);
        if (typeof content === 'string')
            downloadVocabularyExport(content, format);
    };

    return (
        <div>
            <div aria-label="Vocabulary controls">
                <label>
                    Search vocabulary
                    <input
                        type="search"
                        value={searchDraft}
                        onChange={(event) => setSearchDraft(event.target.value)}
                    />
                </label>
                <div role="group" aria-label="Vocabulary date range">
                    {([
                        ['7d', '7 days'],
                        ['30d', '30 days'],
                        ['all', 'All time']
                    ] as const).map(([range, label]) => (
                        <button
                            key={range}
                            type="button"
                            aria-pressed={filter.range === range}
                            onClick={() => updateFilter({ range })}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <label>
                    Source language
                    <select
                        value={filter.sourceLanguage}
                        onChange={(event) => updateFilter({
                            sourceLanguage: event.target.value
                        })}
                    >
                        <option value="">All source languages</option>
                        {sourceLanguages.map((language) => (
                            <option key={language} value={language}>{language}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Target language
                    <select
                        value={filter.targetLanguage}
                        onChange={(event) => updateFilter({
                            targetLanguage: event.target.value
                        })}
                    >
                        <option value="">All target languages</option>
                        {targetLanguages.map((language) => (
                            <option key={language} value={language}>{language}</option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    onClick={() => void exportVocabulary('csv')}
                >
                    Export CSV
                </button>
                <button
                    type="button"
                    onClick={() => void exportVocabulary('json')}
                >
                    Export JSON
                </button>
                <label>
                    <input
                        type="checkbox"
                        checked={memoryPaused}
                        onChange={(event) => toggleMemory(event.target.checked)}
                    />
                    Pause vocabulary memory
                </label>
                <p role="status" aria-label="Vocabulary memory status">
                    {memoryPaused ? 'Vocabulary memory paused' : 'Vocabulary memory active'}
                </p>
                <p role="status" aria-label="Vocabulary privacy">
                    {privacyLocalOnly
                        ? 'Local-only vocabulary storage and processing'
                        : 'Network-assisted vocabulary processing'}
                </p>
            </div>
            <div
                role="region"
                aria-label="Vocabulary rows"
                style={{ maxHeight: viewportHeight, overflow: 'auto' }}
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
                <div
                    role="table"
                    aria-label="Vocabulary heat"
                    aria-colcount={historyMode ? 8 : 5}
                    aria-rowcount={filteredRows.length + 1}
                >
                    <div role="rowgroup">
                        <div role="row" aria-rowindex={1}>
                            <div role="columnheader" aria-colindex={1}>Source</div>
                            {historyMode ? (
                                <>
                                    <div role="columnheader" aria-colindex={2}>Translation</div>
                                    <div role="columnheader" aria-colindex={3}>Normalized</div>
                                    <div role="columnheader" aria-colindex={4}>Languages</div>
                                    <div role="columnheader" aria-colindex={5}>Count</div>
                                    <div role="columnheader" aria-colindex={6}>Recent</div>
                                    <div role="columnheader" aria-colindex={7}>Trend</div>
                                    <div role="columnheader" aria-colindex={8}>Actions</div>
                                </>
                            ) : (
                                <>
                                    <div role="columnheader" aria-colindex={2}>Normalized</div>
                                    <div role="columnheader" aria-colindex={3}>Languages</div>
                                    <div role="columnheader" aria-colindex={4}>Count</div>
                                    <div role="columnheader" aria-colindex={5}>Recent</div>
                                </>
                            )}
                        </div>
                    </div>
                    <div
                        role="rowgroup"
                        style={{
                            height: filteredRows.length * rowHeight,
                            position: 'relative'
                        }}
                    >
                        <div style={{ transform: `translateY(${startRow * rowHeight}px)` }}>
                            {visibleRows.map((row, offset) => {
                                const trend = trendFor(row);
                                return (
                                    <div
                                        key={row.key}
                                        role="row"
                                        aria-rowindex={startRow + offset + 2}
                                        style={{ height: rowHeight }}
                                    >
                                        <div role="rowcell" aria-colindex={1}>{row.sourceText}</div>
                                        {historyMode ? (
                                            <>
                                                <div role="rowcell" aria-colindex={2}>{row.translatedText}</div>
                                                <div role="rowcell" aria-colindex={3}>{row.normalizedSource}</div>
                                                <div role="rowcell" aria-colindex={4}>
                                                    {row.sourceLanguage} → {row.targetLanguage}
                                                </div>
                                                <div role="rowcell" aria-colindex={5}>{row.occurrenceCount}</div>
                                                <div role="rowcell" aria-colindex={6}>{row.recentOccurrenceCount}</div>
                                                <div role="rowcell" aria-colindex={7}>
                                                    <span
                                                        role="meter"
                                                        aria-label={`Frequency trend for ${row.sourceText}`}
                                                        aria-valuemin={0}
                                                        aria-valuemax={100}
                                                        aria-valuenow={trend.value}
                                                    >
                                                        {trend.label}
                                                    </span>
                                                </div>
                                                <div role="rowcell" aria-colindex={8}>
                                                    {row.entryId === undefined ? null : (
                                                        <>
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setDialog({
                                                                        kind: 'context',
                                                                        entryId: row.entryId ?? ''
                                                                    });
                                                                    void actions?.openContext?.(row.entryId ?? '');
                                                                }}
                                                            >
                                                                Open {row.sourceText} context
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => openEdit(row)}
                                                            >
                                                                Edit {row.sourceText}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    if (row.entryId !== undefined)
                                                                        setDialog({
                                                                            kind: 'delete',
                                                                            entryId: row.entryId
                                                                        });
                                                                }}
                                                            >
                                                                Delete {row.sourceText}
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <div role="rowcell" aria-colindex={2}>{row.normalizedSource}</div>
                                                <div role="rowcell" aria-colindex={3}>
                                                    {row.sourceLanguage}{row.targetLanguage}
                                                </div>
                                                <div role="rowcell" aria-colindex={4}>{row.occurrenceCount}</div>
                                                <div role="rowcell" aria-colindex={5}>{row.recentOccurrenceCount}</div>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
            {dialog?.kind === 'context' && currentEntry !== undefined ? (
                <div role="dialog" aria-modal="true" aria-label="Vocabulary context">
                    <h2>Vocabulary context</h2>
                    <p>{currentEntry.context}</p>
                    <button
                        type="button"
                        disabled={currentEntryIndex <= 0}
                        onClick={() => navigateContext(-1)}
                    >
                        Previous entry
                    </button>
                    <button
                        type="button"
                        disabled={currentEntryIndex >= entryRows.length - 1}
                        onClick={() => navigateContext(1)}
                    >
                        Next entry
                    </button>
                    <button type="button" onClick={() => setDialog(undefined)}>
                        Close
                    </button>
                </div>
            ) : null}
            {dialog?.kind === 'edit' ? (
                <div role="dialog" aria-modal="true" aria-label="Edit vocabulary entry">
                    <h2>Edit vocabulary entry</h2>
                    <label>
                        Translation
                        <input
                            value={translationDraft}
                            onChange={(event) => setTranslationDraft(event.target.value)}
                        />
                    </label>
                    <button type="button" onClick={() => void saveEdit()}>
                        Save entry
                    </button>
                    <button type="button" onClick={() => setDialog(undefined)}>
                        Cancel
                    </button>
                </div>
            ) : null}
            {dialog?.kind === 'delete' ? (
                <div role="dialog" aria-modal="true" aria-label="Delete vocabulary entry">
                    <h2>Delete vocabulary entry</h2>
                    <p>Delete this vocabulary entry permanently?</p>
                    <button type="button" onClick={() => void confirmDelete()}>
                        Delete entry
                    </button>
                    <button type="button" onClick={() => setDialog(undefined)}>
                        Cancel
                    </button>
                </div>
            ) : null}
        </div>
    );
}
