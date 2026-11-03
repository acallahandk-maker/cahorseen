import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    MAX_VOCABULARY_EXPORT_CHARS,
    type HeatStatistic,
    type MemoryEntry,
    type MemoryEntryPatch,
    type MemoryExportFormat,
    type VocabularyRepositoryFacade
} from '../../shared/contracts';

export type VocabularyEntryPatch = MemoryEntryPatch;
export type VocabularyExportFormat = MemoryExportFormat;
export type VocabularyTimeRange = '7d' | '30d' | 'all';

export interface VocabularyHeatFilter {
    range: VocabularyTimeRange;
    sourceLanguage: string;
    targetLanguage: string;
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
    now?: Date | number;
    repository?: VocabularyRepositoryFacade;
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
    matchStatus: 'matched' | 'entry-only' | 'statistic-only';
}

interface EditDraft {
    sourceText: string;
    translatedText: string;
    sourceLanguage: string;
    targetLanguage: string;
    context: string;
    quizIntervalDays: string;
    nextDueAt: string;
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

function compareRows(left: VocabularyRow, right: VocabularyRow): number {
    return right.occurrenceCount - left.occurrenceCount
        || right.recentOccurrenceCount - left.recentOccurrenceCount
        || compareText(right.lastUsedAt, left.lastUsedAt)
        || compareText(left.normalizedSource, right.normalizedSource)
        || compareText(left.sourceLanguage, right.sourceLanguage)
        || compareText(left.targetLanguage, right.targetLanguage)
        || compareText(left.entryId ?? left.key, right.entryId ?? right.key);
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

function entryKey(value: {
    normalizedSource: string;
    sourceLanguage: string;
    targetLanguage: string;
}): string {
    return `${value.normalizedSource}:${value.sourceLanguage}:${value.targetLanguage}`;
}

function buildRows(
    statistics: readonly HeatStatistic[],
    entries: readonly MemoryEntry[]
): VocabularyRow[] {
    const entriesByKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
    const matchedEntryIds = new Set<string>();
    const rows: VocabularyRow[] = [];
    for (const statistic of statistics) {
        const entry = entriesByKey.get(entryKey(statistic));
        if (entry !== undefined)
            matchedEntryIds.add(entry.id);
        rows.push({
            key: entry === undefined ? `statistic:${entryKey(statistic)}` : `entry:${entry.id}`,
            ...(entry === undefined ? {} : { entryId: entry.id }),
            sourceText: entry?.sourceText ?? statistic.sourceText,
            normalizedSource: entry?.normalizedSource ?? statistic.normalizedSource,
            translatedText: entry?.translatedText ?? statistic.translatedText,
            sourceLanguage: entry?.sourceLanguage ?? statistic.sourceLanguage,
            targetLanguage: entry?.targetLanguage ?? statistic.targetLanguage,
            occurrenceCount: statistic.occurrenceCount,
            recentOccurrenceCount: statistic.recentOccurrenceCount,
            lastUsedAt: entry?.lastUsedAt ?? statistic.lastUsedAt,
            context: entry?.context ?? '',
            matchStatus: entry === undefined ? 'statistic-only' : 'matched'
        });
    }
    for (const entry of entries) {
        if (matchedEntryIds.has(entry.id))
            continue;
        rows.push({
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
            context: entry.context,
            matchStatus: 'entry-only'
        });
    }
    return rows.sort(compareRows);
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

function isWithinRange(
    lastUsedAt: string,
    range: VocabularyTimeRange,
    nowMs: number
): boolean {
    if (range === 'all')
        return true;
    const days = range === '7d' ? 7 : 30;
    const timestamp = Date.parse(lastUsedAt);
    return Number.isFinite(timestamp)
        && timestamp >= nowMs - days * 24 * 60 * 60 * 1000;
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

function rangeFrom(range: VocabularyTimeRange, nowMs: number): string | undefined {
    if (range === 'all')
        return undefined;
    const days = range === '7d' ? 7 : 30;
    return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

function editDraftFromEntry(entry: MemoryEntry): EditDraft {
    return {
        sourceText: entry.sourceText,
        translatedText: entry.translatedText,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        context: entry.context,
        quizIntervalDays: String(entry.quizIntervalDays),
        nextDueAt: entry.nextDueAt
    };
}

function editPatchFromDraft(entry: MemoryEntry, draft: EditDraft): MemoryEntryPatch {
    const patch: MemoryEntryPatch = {};
    if (draft.sourceText.trim() !== entry.sourceText)
        patch.sourceText = draft.sourceText.trim();
    if (draft.translatedText !== entry.translatedText)
        patch.translatedText = draft.translatedText;
    if (draft.sourceLanguage.trim() !== entry.sourceLanguage)
        patch.sourceLanguage = draft.sourceLanguage.trim();
    if (draft.targetLanguage.trim() !== entry.targetLanguage)
        patch.targetLanguage = draft.targetLanguage.trim();
    if (draft.context !== entry.context)
        patch.context = draft.context;
    const quizIntervalDays = Number(draft.quizIntervalDays);
    if (String(quizIntervalDays) !== String(entry.quizIntervalDays)) {
        if (!Number.isInteger(quizIntervalDays) || quizIntervalDays <= 0)
            throw new Error('Quiz interval days must be a positive integer.');
        patch.quizIntervalDays = quizIntervalDays;
    }
    if (draft.nextDueAt !== entry.nextDueAt) {
        if (!Number.isFinite(Date.parse(draft.nextDueAt)))
            throw new Error('Next due at must be a valid date.');
        patch.nextDueAt = draft.nextDueAt;
    }
    return patch;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.length > 0
        ? error.message
        : fallback;
}

function downloadVocabularyExport(
    content: string,
    format: VocabularyExportFormat
): void {
    const mimeType = format === 'csv'
        ? 'text/csv;charset=utf-8'
        : 'application/json;charset=utf-8';
    const hasObjectUrl = typeof URL.createObjectURL === 'function';
    const blob = new Blob([content], { type: mimeType });
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
    now = Date.now(),
    repository,
    actions,
    memoryPaused: providedMemoryPaused,
    privacyLocalOnly = true,
    virtualization
}: VocabularyHeatViewProps): React.JSX.Element {
    const stableNowMs = useRef(
        typeof now === 'number' ? now : now.getTime()
    ).current;
    const mountedRef = useRef(true);
    const requestGeneration = useRef(0);
    const memoryStateGeneration = useRef(0);
    const dialogGeneration = useRef(0);
    const searchInteractedRef = useRef(false);
    const actionsRef = useRef(actions);
    const [filter, setFilter] = useState<VocabularyHeatFilter>({
        range: 'all',
        sourceLanguage: '',
        targetLanguage: ''
    });
    const [searchDraft, setSearchDraft] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [repositoryStatistics, setRepositoryStatistics] = useState<readonly HeatStatistic[]>(
        statistics
    );
    const [repositoryEntries, setRepositoryEntries] = useState<readonly MemoryEntry[]>(entries);
    const [dialog, setDialog] = useState<VocabularyDialog>();
    const [editDraft, setEditDraft] = useState<EditDraft>();
    const [memoryPaused, setMemoryPaused] = useState<boolean | undefined>(
        repository === undefined ? providedMemoryPaused ?? false : undefined
    );
    const [scrollTop, setScrollTop] = useState(0);
    const [pendingAction, setPendingAction] = useState<
        'edit' | 'delete' | 'export' | 'pause' | 'load' | undefined
    >();
    const [actionError, setActionError] = useState<string>();

    const rowHeight = virtualization?.rowHeight ?? 32;
    const viewportHeight = virtualization?.viewportHeight ?? 320;
    const overscan = virtualization?.overscan ?? 4;
    const activeStatistics = repository ? repositoryStatistics : statistics;
    const activeEntries = repository ? repositoryEntries : entries;
    const historyMode = repository !== undefined || activeEntries.length > 0;
    const rows = useMemo(
        () => buildRows(activeStatistics, activeEntries),
        [activeStatistics, activeEntries]
    );
    const entryRows = useMemo(
        () => rows.filter((row) => row.entryId !== undefined),
        [rows]
    );
    const filteredRows = useMemo(() => rows.filter((row) => (
        isWithinRange(row.lastUsedAt, filter.range, stableNowMs)
        && (filter.sourceLanguage.length === 0
            || row.sourceLanguage === filter.sourceLanguage)
        && (filter.targetLanguage.length === 0
            || row.targetLanguage === filter.targetLanguage)
        && matchesSearch(row, searchDraft)
    )), [rows, filter, stableNowMs, searchDraft]);
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
    const topSpacerHeight = startRow * rowHeight;
    const bottomSpacerHeight = Math.max(
        0,
        (filteredRows.length - startRow - visibleRows.length) * rowHeight
    );
    const currentEntryIndex = dialog === undefined
        ? -1
        : entryRows.findIndex((row) => row.entryId === dialog.entryId);
    const currentEntry = currentEntryIndex < 0 ? undefined : entryRows[currentEntryIndex];

    const loadRepositoryData = useCallback(async (
        query: string,
        generation: number
    ): Promise<void> => {
        if (repository === undefined)
            return;
        const memoryStateVersion = memoryStateGeneration.current;
        const from = rangeFrom(filter.range, stableNowMs);
        const common = {
            ...(filter.sourceLanguage.length === 0
                ? {}
                : { sourceLanguage: filter.sourceLanguage }),
            ...(filter.targetLanguage.length === 0
                ? {}
                : { targetLanguage: filter.targetLanguage }),
            ...(from === undefined ? {} : { from })
        };
        try {
            const [nextStatistics, nextEntries, memoryEnabled] = await Promise.all([
                repository.queryHeat(common),
                repository.listEntries({
                    ...common,
                    ...(query.length === 0 ? {} : { search: query }),
                    limit: 10_000
                }),
                repository.getMemoryEnabled()
            ]);
            if (!mountedRef.current || generation !== requestGeneration.current)
                return;
            setRepositoryStatistics(nextStatistics);
            setRepositoryEntries(nextEntries);
            if (memoryStateVersion === memoryStateGeneration.current)
                setMemoryPaused(!memoryEnabled);
        } catch (error) {
            if (mountedRef.current && generation === requestGeneration.current)
                setActionError(errorMessage(error, 'Vocabulary data could not be loaded.'));
        }
    }, [filter.range, filter.sourceLanguage, filter.targetLanguage, repository, stableNowMs]);

    const runActionSafely = (
        operation: () => Promise<void> | void,
        fallbackMessage: string
    ): void => {
        try {
            void Promise.resolve(operation()).catch((error: unknown) => {
                if (mountedRef.current)
                    setActionError(errorMessage(error, fallbackMessage));
            });
        } catch (error) {
            if (mountedRef.current)
                setActionError(errorMessage(error, fallbackMessage));
        }
    };

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            requestGeneration.current += 1;
            memoryStateGeneration.current += 1;
            dialogGeneration.current += 1;
        };
    }, []);

    useEffect(() => {
        actionsRef.current = actions;
    }, [actions]);

    useEffect(() => {
        if (repository === undefined && providedMemoryPaused !== undefined)
            setMemoryPaused(providedMemoryPaused);
    }, [providedMemoryPaused, repository]);

    useEffect(() => {
        const generation = ++requestGeneration.current;
        void loadRepositoryData(searchQuery, generation);
    }, [loadRepositoryData, searchQuery]);

    useEffect(() => {
        const action = actionsRef.current?.filterHeat;
        if (action !== undefined)
            runActionSafely(() => action(filter), 'Vocabulary filtering failed.');
    }, [filter]);

    useEffect(() => {
        if (!searchInteractedRef.current)
            return;
        const timeout = window.setTimeout(() => {
            setSearchQuery(searchDraft);
            const action = actionsRef.current?.searchEntries;
            if (action !== undefined)
                runActionSafely(() => action(searchDraft), 'Vocabulary search failed.');
        }, 300);
        return () => window.clearTimeout(timeout);
    }, [searchDraft]);

    const refreshAfterMutation = async (): Promise<void> => {
        const generation = ++requestGeneration.current;
        await loadRepositoryData(searchQuery, generation);
    };

    const setDialogSafely = (nextDialog: VocabularyDialog | undefined): void => {
        dialogGeneration.current += 1;
        setDialog(nextDialog);
    };

    const openEdit = (row: VocabularyRow): void => {
        if (row.entryId === undefined)
            return;
        const entry = activeEntries.find((candidate) => candidate.id === row.entryId);
        if (entry === undefined)
            return;
        setEditDraft(editDraftFromEntry(entry));
        setActionError(undefined);
        setDialogSafely({ kind: 'edit', entryId: entry.id });
    };

    const saveEdit = async (): Promise<void> => {
        if (dialog?.kind !== 'edit' || editDraft === undefined || pendingAction !== undefined)
            return;
        const entry = activeEntries.find((candidate) => candidate.id === dialog.entryId);
        if (entry === undefined)
            return;
        const operationGeneration = dialogGeneration.current;
        setPendingAction('edit');
        setActionError(undefined);
        try {
            const patch = editPatchFromDraft(entry, editDraft);
            if (Object.keys(patch).length > 0) {
                if (repository !== undefined)
                    await repository.updateEntry(entry.id, patch);
                else
                    await actionsRef.current?.editEntry?.(entry.id, patch);
                await refreshAfterMutation();
            }
            if (!mountedRef.current || operationGeneration !== dialogGeneration.current)
                return;
            setDialog(undefined);
            setEditDraft(undefined);
        } catch (error) {
            if (mountedRef.current && operationGeneration === dialogGeneration.current)
                setActionError(errorMessage(error, 'Vocabulary entry could not be updated.'));
        } finally {
            if (mountedRef.current)
                setPendingAction(undefined);
        }
    };

    const confirmDelete = async (): Promise<void> => {
        if (dialog?.kind !== 'delete' || pendingAction !== undefined)
            return;
        const operationGeneration = dialogGeneration.current;
        setPendingAction('delete');
        setActionError(undefined);
        try {
            if (repository !== undefined)
                await repository.deleteEntries([dialog.entryId]);
            else
                await actionsRef.current?.deleteEntry?.(dialog.entryId);
            await refreshAfterMutation();
            if (!mountedRef.current || operationGeneration !== dialogGeneration.current)
                return;
            setDialog(undefined);
        } catch (error) {
            if (mountedRef.current && operationGeneration === dialogGeneration.current)
                setActionError(errorMessage(error, 'Vocabulary entry could not be deleted.'));
        } finally {
            if (mountedRef.current)
                setPendingAction(undefined);
        }
    };

    const exportVocabulary = async (
        format: VocabularyExportFormat
    ): Promise<void> => {
        if (pendingAction !== undefined)
            return;
        setPendingAction('export');
        setActionError(undefined);
        try {
            const content = repository !== undefined
                ? await repository.exportEntries(format)
                : await actionsRef.current?.exportEntries?.(format);
            if (content === undefined)
                return;
            if (content.length > MAX_VOCABULARY_EXPORT_CHARS) {
                throw new Error(
                    `Vocabulary export exceeds the ${MAX_VOCABULARY_EXPORT_CHARS.toLocaleString()} character limit.`
                );
            }
            downloadVocabularyExport(content, format);
        } catch (error) {
            if (mountedRef.current)
                setActionError(errorMessage(error, 'Vocabulary export failed.'));
        } finally {
            if (mountedRef.current)
                setPendingAction(undefined);
        }
    };

    const toggleMemory = async (paused: boolean): Promise<void> => {
        if (pendingAction !== undefined)
            return;
        const previous = memoryPaused;
        memoryStateGeneration.current += 1;
        setMemoryPaused(paused);
        setPendingAction('pause');
        setActionError(undefined);
        try {
            if (repository !== undefined)
                await repository.setMemoryEnabled(!paused);
            else
                await actionsRef.current?.toggleMemory?.(paused);
        } catch (error) {
            if (mountedRef.current) {
                setMemoryPaused(previous);
                setActionError(errorMessage(error, 'Vocabulary memory setting failed.'));
            }
        } finally {
            memoryStateGeneration.current += 1;
            if (mountedRef.current)
                setPendingAction(undefined);
        }
    };

    const canOpenContext = repository !== undefined
        || actions?.openContext !== undefined;
    const canEdit = repository !== undefined || actions?.editEntry !== undefined;
    const canDelete = repository !== undefined || actions?.deleteEntry !== undefined;
    const canExport = repository !== undefined || actions?.exportEntries !== undefined;
    const canPause = repository !== undefined || actions?.toggleMemory !== undefined;

    return (
        <div>
            <div aria-label="Vocabulary controls">
                <label>
                    Search vocabulary
                    <input
                        type="search"
                        value={searchDraft}
                        onChange={(event) => {
                            searchInteractedRef.current = true;
                            setSearchDraft(event.target.value);
                        }}
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
                            onClick={() => setFilter((current) => ({ ...current, range }))}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <label>
                    Source language
                    <select
                        value={filter.sourceLanguage}
                        onChange={(event) => setFilter((current) => ({
                            ...current,
                            sourceLanguage: event.target.value
                        }))}
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
                        onChange={(event) => setFilter((current) => ({
                            ...current,
                            targetLanguage: event.target.value
                        }))}
                    >
                        <option value="">All target languages</option>
                        {targetLanguages.map((language) => (
                            <option key={language} value={language}>{language}</option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    disabled={!canExport || pendingAction !== undefined}
                    onClick={() => void exportVocabulary('csv')}
                >
                    Export CSV
                </button>
                <button
                    type="button"
                    disabled={!canExport || pendingAction !== undefined}
                    onClick={() => void exportVocabulary('json')}
                >
                    Export JSON
                </button>
                <label>
                    <input
                        type="checkbox"
                        checked={memoryPaused ?? false}
                        disabled={!canPause || memoryPaused === undefined || pendingAction !== undefined}
                        onChange={(event) => void toggleMemory(event.target.checked)}
                    />
                    Pause vocabulary memory
                </label>
                <p role="status" aria-label="Vocabulary memory status">
                    {memoryPaused === undefined
                        ? 'Vocabulary memory status loading'
                        : memoryPaused
                            ? 'Vocabulary memory paused'
                            : 'Vocabulary memory active'}
                </p>
                <p role="status" aria-label="Vocabulary privacy">
                    {privacyLocalOnly
                        ? 'Local-only vocabulary storage and processing'
                        : 'Network-assisted vocabulary processing'}
                </p>
                {actionError === undefined ? null : (
                    <p role="alert" aria-label="Vocabulary action error">{actionError}</p>
                )}
            </div>
            <div
                role="region"
                aria-label="Vocabulary rows"
                style={{ maxHeight: viewportHeight, overflow: 'auto' }}
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
                <table
                    aria-label="Vocabulary heat"
                    aria-colcount={historyMode ? 8 : 5}
                    aria-rowcount={filteredRows.length + 1}
                    style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%' }}
                >
                    <colgroup>
                        {(historyMode
                            ? [16, 18, 16, 12, 8, 8, 10, 12]
                            : [24, 24, 22, 15, 15]
                        ).map((width, index) => (
                            <col key={index} style={{ width: `${width}%` }} />
                        ))}
                    </colgroup>
                    <thead>
                        <tr aria-rowindex={1}>
                            <th scope="col">Source</th>
                            {historyMode ? (
                                <>
                                    <th scope="col">Translation</th>
                                    <th scope="col">Normalized</th>
                                    <th scope="col">Languages</th>
                                    <th scope="col">Count</th>
                                    <th scope="col">Recent</th>
                                    <th scope="col">Trend</th>
                                    <th scope="col">Actions</th>
                                </>
                            ) : (
                                <>
                                    <th scope="col">Normalized</th>
                                    <th scope="col">Languages</th>
                                    <th scope="col">Count</th>
                                    <th scope="col">Recent</th>
                                </>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {topSpacerHeight > 0 ? (
                            <tr aria-hidden="true">
                                <td
                                    colSpan={historyMode ? 8 : 5}
                                    style={{ border: 0, height: topSpacerHeight, padding: 0 }}
                                />
                            </tr>
                        ) : null}
                        {visibleRows.map((row, offset) => {
                            const trend = trendFor(row);
                            return (
                                <tr
                                    key={row.key}
                                    aria-rowindex={startRow + offset + 2}
                                    style={{ height: rowHeight }}
                                >
                                    <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {row.sourceText}
                                        {historyMode && row.matchStatus === 'entry-only'
                                            ? <span>Entry-only</span>
                                            : null}
                                        {historyMode && row.matchStatus === 'statistic-only'
                                            ? <span>Statistic-only</span>
                                            : null}
                                    </td>
                                    {historyMode ? (
                                        <>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.translatedText}</td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.normalizedSource}</td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {row.sourceLanguage} → {row.targetLanguage}
                                            </td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.occurrenceCount}</td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.recentOccurrenceCount}</td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                <span
                                                    role="meter"
                                                    aria-label={`Frequency trend for ${row.sourceText}`}
                                                    aria-valuemin={0}
                                                    aria-valuemax={100}
                                                    aria-valuenow={trend.value}
                                                >
                                                    {trend.label}
                                                </span>
                                            </td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {row.entryId === undefined ? null : (
                                                    <>
                                                        <button
                                                            type="button"
                                                            disabled={!canOpenContext}
                                                            onClick={() => {
                                                                setActionError(undefined);
                                                                setDialogSafely({
                                                                    kind: 'context',
                                                                    entryId: row.entryId ?? ''
                                                                });
                                                                void actionsRef.current?.openContext?.(row.entryId ?? '');
                                                            }}
                                                        >
                                                            Open {row.sourceText} context
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={!canEdit}
                                                            onClick={() => openEdit(row)}
                                                        >
                                                            Edit {row.sourceText}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={!canDelete}
                                                            onClick={() => {
                                                                if (row.entryId !== undefined)
                                                                    setDialogSafely({
                                                                        kind: 'delete',
                                                                        entryId: row.entryId
                                                                    });
                                                            }}
                                                        >
                                                            Delete {row.sourceText}
                                                        </button>
                                                    </>
                                                )}
                                            </td>
                                        </>
                                    ) : (
                                        <>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.normalizedSource}</td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {row.sourceLanguage}{row.targetLanguage}
                                            </td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.occurrenceCount}</td>
                                            <td style={{ height: rowHeight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.recentOccurrenceCount}</td>
                                        </>
                                    )}
                                </tr>
                            );
                        })}
                        {bottomSpacerHeight > 0 ? (
                            <tr aria-hidden="true">
                                <td
                                    colSpan={historyMode ? 8 : 5}
                                    style={{ border: 0, height: bottomSpacerHeight, padding: 0 }}
                                />
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
            {dialog?.kind === 'context' && currentEntry !== undefined ? (
                <div role="dialog" aria-modal="true" aria-label="Vocabulary context">
                    <h2>Vocabulary context</h2>
                    <p>{currentEntry.context}</p>
                    <button
                        type="button"
                        disabled={currentEntryIndex <= 0}
                        onClick={() => {
                            const nextEntry = entryRows[currentEntryIndex - 1];
                            if (nextEntry?.entryId !== undefined) {
                                setDialogSafely({ kind: 'context', entryId: nextEntry.entryId });
                                void actionsRef.current?.openContext?.(nextEntry.entryId);
                            }
                        }}
                    >
                        Previous entry
                    </button>
                    <button
                        type="button"
                        disabled={currentEntryIndex >= entryRows.length - 1}
                        onClick={() => {
                            const nextEntry = entryRows[currentEntryIndex + 1];
                            if (nextEntry?.entryId !== undefined) {
                                setDialogSafely({ kind: 'context', entryId: nextEntry.entryId });
                                void actionsRef.current?.openContext?.(nextEntry.entryId);
                            }
                        }}
                    >
                        Next entry
                    </button>
                    <button type="button" onClick={() => setDialogSafely(undefined)}>
                        Close
                    </button>
                </div>
            ) : null}
            {dialog?.kind === 'edit' && editDraft !== undefined ? (
                <div role="dialog" aria-modal="true" aria-label="Edit vocabulary entry">
                    <h2>Edit vocabulary entry</h2>
                    <label>
                        Source text
                        <input
                            value={editDraft.sourceText}
                            onChange={(event) => setEditDraft({
                                ...editDraft,
                                sourceText: event.target.value
                            })}
                        />
                    </label>
                    <label>
                        Translation
                        <input
                            value={editDraft.translatedText}
                            onChange={(event) => setEditDraft({
                                ...editDraft,
                                translatedText: event.target.value
                            })}
                        />
                    </label>
                    <label>
                        Source language
                        <input
                            value={editDraft.sourceLanguage}
                            onChange={(event) => setEditDraft({
                                ...editDraft,
                                sourceLanguage: event.target.value
                            })}
                        />
                    </label>
                    <label>
                        Target language
                        <input
                            value={editDraft.targetLanguage}
                            onChange={(event) => setEditDraft({
                                ...editDraft,
                                targetLanguage: event.target.value
                            })}
                        />
                    </label>
                    <label>
                        Context
                        <input
                            value={editDraft.context}
                            onChange={(event) => setEditDraft({
                                ...editDraft,
                                context: event.target.value
                            })}
                        />
                    </label>
                    <label>
                        Quiz interval days
                        <input
                            type="number"
                            min={1}
                            value={editDraft.quizIntervalDays}
                            onChange={(event) => setEditDraft({
                                ...editDraft,
                                quizIntervalDays: event.target.value
                            })}
                        />
                    </label>
                    <label>
                        Next due at (ISO)
                        <input
                            value={editDraft.nextDueAt}
                            onChange={(event) => setEditDraft({
                                ...editDraft,
                                nextDueAt: event.target.value
                            })}
                        />
                    </label>
                    <button
                        type="button"
                        disabled={pendingAction !== undefined}
                        onClick={() => void saveEdit()}
                    >
                        Save entry
                    </button>
                    <button
                        type="button"
                        disabled={pendingAction !== undefined}
                        onClick={() => setDialogSafely(undefined)}
                    >
                        Cancel
                    </button>
                </div>
            ) : null}
            {dialog?.kind === 'delete' ? (
                <div role="dialog" aria-modal="true" aria-label="Delete vocabulary entry">
                    <h2>Delete vocabulary entry</h2>
                    <p>Delete this vocabulary entry permanently?</p>
                    <button
                        type="button"
                        disabled={pendingAction !== undefined}
                        onClick={() => void confirmDelete()}
                    >
                        Delete entry
                    </button>
                    <button
                        type="button"
                        disabled={pendingAction !== undefined}
                        onClick={() => setDialogSafely(undefined)}
                    >
                        Cancel
                    </button>
                </div>
            ) : null}
        </div>
    );
}
