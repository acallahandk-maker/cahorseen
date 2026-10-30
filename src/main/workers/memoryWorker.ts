import { createHash, randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { caseFold } from 'unicode-case-folding';
import { z } from 'zod';
import {
    type HeatStatistic,
    type MemoryEntry,
    type TranslationTask
} from '../../shared/contracts';
import {
    memoryWorkerRequestSchema,
    type MemoryWorkerRequest
} from '../services/memoryDatabase';
import { validateVocabularySourceText } from '../../shared/vocabularyText';

const databaseOptionsSchema = z.strictObject({
    databasePath: z.string().min(1)
});

type DatabaseType = Database.Database;
type EntryRow = {
    id: string;
    source_text: string;
    normalized_source: string;
    translated_text: string;
    source_language: string;
    target_language: string;
    first_seen_at_ms: number;
    last_used_at_ms: number;
    context: string;
    quiz_interval_days: number;
    next_due_at_ms: number;
    occurrence_count: number;
    recent_occurrence_count: number;
};

type LegacyEntryRow = {
    id: string;
    source_text: string;
    normalized_source: string;
    translated_text: string;
    source_language: string;
    target_language: string;
    first_seen_at: string;
    last_used_at: string;
    context: string;
    quiz_interval_days: number;
    next_due_at: string;
};

type LegacyOccurrenceRow = {
    entry_id: string;
    task_id: string;
    occurred_at: string;
};

type StoredEntryRow = {
    id: string;
    source_text: string;
    normalized_source: string;
    translated_text: string;
    source_language: string;
    target_language: string;
    first_seen_at_ms: number | string;
    last_used_at_ms: number | string;
    context: string;
    quiz_interval_days: number;
    next_due_at_ms: number | string;
};

type StoredOccurrenceRow = {
    entry_id: string;
    task_id: string;
    occurred_at_ms: number | string;
};

type MergedEntryRow = {
    id: string;
    source_text: string;
    normalized_source: string;
    translated_text: string;
    source_language: string;
    target_language: string;
    first_seen_at_ms: number;
    last_used_at_ms: number;
    context: string;
    quiz_interval_days: number;
    next_due_at_ms: number;
};

type MergedEntryGroup = {
    candidates: StoredEntryRow[];
    entry: MergedEntryRow;
};

type WorkerFilter = Extract<MemoryWorkerRequest, { operation: 'queryHeat' }>['filter'];
type WorkerEntryPatch = Extract<MemoryWorkerRequest, { operation: 'updateEntry' }>['patch'];

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * DAY_MS;

function normalizeSource(value: string): string {
    const normalized = value
        .normalize('NFKC')
        .trim()
        .replace(/\s+/gu, ' ');
    if (normalized.length === 0)
        throw new Error('source text must contain non-whitespace characters');
    return caseFold(normalized);
}

function normalizeLanguage(value: string | undefined, fallback: string): string {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0 || trimmed.toLowerCase() === 'unknown')
        return fallback;
    try {
        return Intl.getCanonicalLocales(trimmed)[0] ?? fallback;
    } catch {
        return fallback;
    }
}

function entryId(normalizedSource: string, sourceLanguage: string, targetLanguage: string): string {
    return createHash('sha256')
        .update(`${normalizedSource}\0${sourceLanguage}\0${targetLanguage}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
}

function toIso(milliseconds: number): string {
    return new Date(milliseconds).toISOString();
}

function toEpochMilliseconds(value: string | number): number {
    const milliseconds = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(milliseconds))
        throw new Error('invalid timestamp');
    return milliseconds;
}

function addDays(milliseconds: number, days: number): number {
    return milliseconds + days * DAY_MS;
}

function isUniqueConstraint(error: unknown): boolean {
    return error instanceof Error
        && (error.message.includes('UNIQUE') || error.message.includes('constraint failed'));
}

function isInputError(error: unknown): boolean {
    return error instanceof Error
        && (error.message === 'invalid timestamp'
            || error.message === 'source text must contain non-whitespace characters'
            || error.message === 'invalid vocabulary source text');
}

function createLegacySchema(database: DatabaseType, now: string): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS entries (
            id TEXT PRIMARY KEY,
            source_text TEXT NOT NULL,
            normalized_source TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            source_language TEXT NOT NULL,
            target_language TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL,
            context TEXT NOT NULL,
            quiz_interval_days INTEGER NOT NULL CHECK (quiz_interval_days > 0),
            next_due_at TEXT NOT NULL,
            UNIQUE(normalized_source, source_language, target_language)
        );
        CREATE TABLE IF NOT EXISTS occurrences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            UNIQUE(entry_id, task_id),
            FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO metadata(key, value) VALUES ('memory_enabled', '1');
        INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${now}');
    `);
}

function createEpochSchema(database: DatabaseType): void {
    database.exec(`
        CREATE TABLE entries (
            id TEXT PRIMARY KEY,
            source_text TEXT NOT NULL,
            normalized_source TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            source_language TEXT NOT NULL,
            target_language TEXT NOT NULL,
            first_seen_at_ms INTEGER NOT NULL,
            last_used_at_ms INTEGER NOT NULL,
            context TEXT NOT NULL,
            quiz_interval_days INTEGER NOT NULL CHECK (quiz_interval_days > 0),
            next_due_at_ms INTEGER NOT NULL,
            UNIQUE(normalized_source, source_language, target_language)
        );
        CREATE TABLE occurrences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            occurred_at_ms INTEGER NOT NULL,
            UNIQUE(entry_id, task_id),
            FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_entries_normalized_source ON entries(normalized_source);
        CREATE INDEX idx_entries_language_timestamps
            ON entries(source_language, target_language, last_used_at_ms);
        CREATE INDEX idx_entries_last_used_at_ms ON entries(last_used_at_ms);
        CREATE INDEX idx_occurrences_entry_time
            ON occurrences(entry_id, occurred_at_ms);
        CREATE INDEX idx_occurrences_time ON occurrences(occurred_at_ms);
        CREATE TABLE IF NOT EXISTS entry_merge_history (
            identity TEXT NOT NULL,
            selected_entry_id TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            merged_at TEXT NOT NULL,
            PRIMARY KEY(identity, entry_id)
        );
        CREATE INDEX IF NOT EXISTS idx_entry_merge_history_selected
            ON entry_merge_history(selected_entry_id);
    `);
}

function mergedIdentity(entry: StoredEntryRow): string {
    return JSON.stringify([
        normalizeSource(entry.source_text),
        normalizeLanguage(entry.source_language, 'unknown'),
        normalizeLanguage(entry.target_language, 'unknown')
    ]);
}

function entryPreference(entry: StoredEntryRow): number {
    return (entry.context.trim().length > 0 ? 2 : 0)
        + (entry.quiz_interval_days === 1 ? 0 : 1);
}

function preferEntry(current: StoredEntryRow, candidate: StoredEntryRow): StoredEntryRow {
    const preference = entryPreference(candidate) - entryPreference(current);
    if (preference !== 0)
        return preference > 0 ? candidate : current;
    return toEpochMilliseconds(candidate.last_used_at_ms)
        > toEpochMilliseconds(current.last_used_at_ms)
        ? candidate
        : current;
}

function snapshotStoredEntry(entry: StoredEntryRow): Record<string, string | number> {
    return {
        id: entry.id,
        source_text: entry.source_text,
        normalized_source: entry.normalized_source,
        translated_text: entry.translated_text,
        source_language: entry.source_language,
        target_language: entry.target_language,
        first_seen_at_ms: toEpochMilliseconds(entry.first_seen_at_ms),
        last_used_at_ms: toEpochMilliseconds(entry.last_used_at_ms),
        context: entry.context,
        quiz_interval_days: entry.quiz_interval_days,
        next_due_at_ms: toEpochMilliseconds(entry.next_due_at_ms)
    };
}

function mergeStoredEntries(entries: StoredEntryRow[]): MergedEntryGroup[] {
    const merged = new Map<string, {
        candidates: StoredEntryRow[];
        entry: StoredEntryRow;
    }>();
    for (const entry of entries) {
        const key = mergedIdentity(entry);
        const previous = merged.get(key);
        merged.set(key, {
            candidates: previous === undefined ? [entry] : [...previous.candidates, entry],
            entry: previous === undefined ? entry : preferEntry(previous.entry, entry)
        });
    }
    return [...merged.values()].map(({ candidates, entry }) => {
        const firstSeenAtMs = Math.min(...candidates.map((candidate) => (
            toEpochMilliseconds(candidate.first_seen_at_ms)
        )));
        const lastUsedAtMs = Math.max(...candidates.map((candidate) => (
            toEpochMilliseconds(candidate.last_used_at_ms)
        )));
        return {
            candidates: [...candidates].sort((left, right) => left.id.localeCompare(right.id)),
            entry: {
                id: entry.id,
                source_text: entry.source_text.trim(),
                normalized_source: normalizeSource(entry.source_text),
                translated_text: entry.translated_text,
                source_language: normalizeLanguage(entry.source_language, 'unknown'),
                target_language: normalizeLanguage(entry.target_language, 'unknown'),
                first_seen_at_ms: firstSeenAtMs,
                last_used_at_ms: lastUsedAtMs,
                context: entry.context,
                quiz_interval_days: entry.quiz_interval_days,
                next_due_at_ms: toEpochMilliseconds(entry.next_due_at_ms)
            }
        };
    });
}

function reconcileStoredEntries(
    database: DatabaseType,
    now: string,
    migrationVersions: number[]
): void {
    const entries = database.prepare(
        'SELECT * FROM entries ORDER BY id'
    ).all() as StoredEntryRow[];
    const occurrences = database.prepare(
        'SELECT * FROM occurrences ORDER BY id'
    ).all() as StoredOccurrenceRow[];
    const mergedGroups = mergeStoredEntries(entries);
    const mergedEntries = mergedGroups.map((group) => group.entry);
    const entryIdentityById = new Map(
        entries.map((entry) => [entry.id, mergedIdentity(entry)])
    );
    const mergedById = new Map(
        mergedEntries.map((entry) => [
            JSON.stringify([
                entry.normalized_source,
                entry.source_language,
                entry.target_language
            ]),
            entry
        ])
    );
    database.pragma('foreign_keys = OFF');
    try {
        database.transaction(() => {
            database.exec(`
                CREATE TABLE IF NOT EXISTS entry_merge_history (
                    identity TEXT NOT NULL,
                    selected_entry_id TEXT NOT NULL,
                    entry_id TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    merged_at TEXT NOT NULL,
                    PRIMARY KEY(identity, entry_id)
                );
                CREATE INDEX IF NOT EXISTS idx_entry_merge_history_selected
                    ON entry_merge_history(selected_entry_id);
            `);
            const insertHistory = database.prepare(`
                INSERT OR IGNORE INTO entry_merge_history (
                    identity, selected_entry_id, entry_id, snapshot_json, merged_at
                ) VALUES (?, ?, ?, ?, ?)
            `);
            for (const group of mergedGroups) {
                const identity = mergedIdentity(group.candidates[0]);
                for (const candidate of group.candidates) {
                    insertHistory.run(
                        identity,
                        group.entry.id,
                        candidate.id,
                        JSON.stringify(snapshotStoredEntry(candidate)),
                        now
                    );
                }
            }
            database.exec('DROP TABLE occurrences; DROP TABLE entries;');
            createEpochSchema(database);
            const insertEntry = database.prepare(`
                INSERT INTO entries (
                    id, source_text, normalized_source, translated_text,
                    source_language, target_language, first_seen_at_ms,
                    last_used_at_ms, context, quiz_interval_days, next_due_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const entry of mergedEntries) {
                insertEntry.run(
                    entry.id,
                    entry.source_text,
                    entry.normalized_source,
                    entry.translated_text,
                    entry.source_language,
                    entry.target_language,
                    entry.first_seen_at_ms,
                    entry.last_used_at_ms,
                    entry.context,
                    entry.quiz_interval_days,
                    entry.next_due_at_ms
                );
            }
            const insertOccurrence = database.prepare(`
                INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
                VALUES (?, ?, ?)
                ON CONFLICT(entry_id, task_id) DO NOTHING
            `);
            const updateDates = database.prepare(`
                UPDATE entries SET
                    first_seen_at_ms = CASE WHEN ? < first_seen_at_ms THEN ? ELSE first_seen_at_ms END,
                    last_used_at_ms = CASE WHEN ? > last_used_at_ms THEN ? ELSE last_used_at_ms END
                WHERE id = ?
            `);
            const seenOccurrences = new Set<string>();
            for (const occurrence of occurrences) {
                const identity = entryIdentityById.get(occurrence.entry_id);
                if (identity === undefined)
                    throw new Error('orphan occurrence');
                const entry = mergedById.get(identity);
                if (entry === undefined)
                    throw new Error('orphan occurrence');
                const occurredAtMs = toEpochMilliseconds(occurrence.occurred_at_ms);
                updateDates.run(
                    occurredAtMs,
                    occurredAtMs,
                    occurredAtMs,
                    occurredAtMs,
                    entry.id
                );
                const occurrenceKey = JSON.stringify([entry.id, occurrence.task_id]);
                if (seenOccurrences.has(occurrenceKey))
                    continue;
                seenOccurrences.add(occurrenceKey);
                insertOccurrence.run(entry.id, occurrence.task_id, occurredAtMs);
            }
            const insertMigration = database.prepare(
                'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)'
            );
            for (const version of migrationVersions)
                insertMigration.run(version, now);
        })();
    } finally {
        database.pragma('foreign_keys = ON');
    }
}

function migrate(database: DatabaseType, now: string): void {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    `);
    const current = database.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
    ).get() as { version: number };
    if (current.version < 1)
        database.transaction(() => createLegacySchema(database, now))();
    if (current.version < 2) {
        const entries = database.prepare('SELECT * FROM entries').all() as LegacyEntryRow[];
        const occurrences = database.prepare('SELECT * FROM occurrences').all() as LegacyOccurrenceRow[];
        database.pragma('foreign_keys = OFF');
        try {
            database.transaction(() => {
                database.exec('DROP TABLE occurrences; DROP TABLE entries;');
                createEpochSchema(database);
                const insertEntry = database.prepare(`
                    INSERT INTO entries (
                        id, source_text, normalized_source, translated_text,
                        source_language, target_language, first_seen_at_ms,
                        last_used_at_ms, context, quiz_interval_days, next_due_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                for (const entry of entries) {
                    insertEntry.run(
                        entry.id,
                        entry.source_text,
                        entry.normalized_source,
                        entry.translated_text,
                        entry.source_language,
                        entry.target_language,
                        toEpochMilliseconds(entry.first_seen_at),
                        toEpochMilliseconds(entry.last_used_at),
                        entry.context,
                        entry.quiz_interval_days,
                        toEpochMilliseconds(entry.next_due_at)
                    );
                }
                const insertOccurrence = database.prepare(`
                    INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
                    VALUES (?, ?, ?)
                `);
                for (const occurrence of occurrences) {
                    insertOccurrence.run(
                        occurrence.entry_id,
                        occurrence.task_id,
                        toEpochMilliseconds(occurrence.occurred_at)
                    );
                }
                database.prepare(
                    'INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)'
                ).run(now);
            })();
        } finally {
            database.pragma('foreign_keys = ON');
        }
    }
    if (current.version < 4) {
        reconcileStoredEntries(
            database,
            now,
            current.version < 3 ? [3, 4] : [4]
        );
    }
    database.pragma('foreign_keys = ON');
}

function memoryEnabled(database: DatabaseType): boolean {
    const row = database.prepare(
        "SELECT value FROM metadata WHERE key = 'memory_enabled'"
    ).get() as { value: string } | undefined;
    return row?.value !== '0';
}

function writeRecord(
    database: DatabaseType,
    task: TranslationTask,
    recordedAtMs: number
): void {
    const sourceText = validateVocabularySourceText(task.sourceText);
    const normalizedSource = normalizeSource(sourceText);
    const sourceLanguage = normalizeLanguage(task.sourceLanguage, 'unknown');
    const targetLanguage = normalizeLanguage(task.targetLanguage, 'unknown');
    const identity = database.prepare(`
        SELECT id FROM entries
        WHERE normalized_source = ? AND source_language = ? AND target_language = ?
    `).get(normalizedSource, sourceLanguage, targetLanguage) as { id: string } | undefined;
    let id = identity?.id;
    if (id === undefined) {
        id = entryId(normalizedSource, sourceLanguage, targetLanguage);
        if (database.prepare('SELECT 1 FROM entries WHERE id = ?').get(id) !== undefined)
            id = `${id}:${randomUUID()}`;
    }
    const previous = database.prepare(`
        SELECT first_seen_at_ms, last_used_at_ms
        FROM entries WHERE id = ?
    `).get(id) as { first_seen_at_ms: number; last_used_at_ms: number } | undefined;
    if (previous === undefined) {
        database.prepare(`
            INSERT INTO entries (
                id, source_text, normalized_source, translated_text,
                source_language, target_language, first_seen_at_ms, last_used_at_ms,
                context, quiz_interval_days, next_due_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
            id,
            sourceText,
            normalizedSource,
            task.translatedText,
            sourceLanguage,
            targetLanguage,
            recordedAtMs,
            recordedAtMs,
            '',
            addDays(recordedAtMs, 1)
        );
    } else {
        database.prepare(`
            UPDATE entries SET
                first_seen_at_ms = CASE WHEN ? < first_seen_at_ms THEN ? ELSE first_seen_at_ms END,
                last_used_at_ms = CASE WHEN ? > last_used_at_ms THEN ? ELSE last_used_at_ms END,
                translated_text = CASE WHEN ? >= last_used_at_ms THEN ? ELSE translated_text END,
                context = CASE WHEN ? >= last_used_at_ms THEN ? ELSE context END
            WHERE id = ?
        `).run(
            recordedAtMs,
            recordedAtMs,
            recordedAtMs,
            recordedAtMs,
            recordedAtMs,
            task.translatedText,
            recordedAtMs,
            '',
            id
        );
    }
    database.prepare(`
        INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(entry_id, task_id) DO NOTHING
    `).run(id, task.id, recordedAtMs);
}

function filterSql(filter: WorkerFilter): { sql: string; parameters: (string | number)[] } {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (filter.sourceLanguage !== undefined) {
        clauses.push('e.source_language = ?');
        parameters.push(normalizeLanguage(filter.sourceLanguage, 'unknown'));
    }
    if (filter.targetLanguage !== undefined) {
        clauses.push('e.target_language = ?');
        parameters.push(normalizeLanguage(filter.targetLanguage, 'unknown'));
    }
    if (filter.fromMs !== undefined || filter.toMs !== undefined) {
        const bounds: string[] = [];
        if (filter.fromMs !== undefined) {
            bounds.push('filter_occurrences.occurred_at_ms >= ?');
            parameters.push(filter.fromMs);
        }
        if (filter.toMs !== undefined) {
            bounds.push('filter_occurrences.occurred_at_ms <= ?');
            parameters.push(filter.toMs);
        }
        clauses.push(`EXISTS (
            SELECT 1 FROM occurrences filter_occurrences
            WHERE filter_occurrences.entry_id = e.id
              AND ${bounds.join(' AND ')}
        )`);
    }
    return {
        sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`,
        parameters
    };
}

function queryEntries(
    database: DatabaseType,
    filter: WorkerFilter,
    nowMs: number,
    search?: string,
    limit?: number
): EntryRow[] {
    const filterPart = filterSql(filter);
    const clauses = filterPart.sql === '' ? [] : [filterPart.sql.slice(6)];
    const parameters: (string | number)[] = [...filterPart.parameters];
    const normalizedSearch = search?.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (normalizedSearch !== undefined && normalizedSearch.length > 0) {
        clauses.push(`(
            e.normalized_source LIKE ?
            OR e.source_text LIKE ?
            OR e.translated_text LIKE ?
        )`);
        const term = `%${caseFold(normalizedSearch)}%`;
        parameters.push(term, term, term);
    }
    const recentStartMs = nowMs - RECENT_WINDOW_MS;
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = database.prepare(`
        SELECT e.*,
            (SELECT COUNT(*) FROM occurrences count_occurrences
             WHERE count_occurrences.entry_id = e.id) AS occurrence_count,
            (SELECT COUNT(*) FROM occurrences recent_occurrences
             WHERE recent_occurrences.entry_id = e.id
               AND recent_occurrences.occurred_at_ms >= ?
               AND recent_occurrences.occurred_at_ms <= ?) AS recent_occurrence_count
        FROM entries e
        ${where}
        ORDER BY e.last_used_at_ms DESC, e.id ASC
        ${limit === undefined ? '' : 'LIMIT ?'}
    `).all(
        recentStartMs,
        nowMs,
        ...parameters,
        ...(limit === undefined ? [] : [limit])
    ) as EntryRow[];
    return rows;
}

function toMemoryEntry(row: EntryRow): MemoryEntry {
    return {
        id: row.id,
        sourceText: row.source_text,
        normalizedSource: row.normalized_source,
        translatedText: row.translated_text,
        sourceLanguage: row.source_language,
        targetLanguage: row.target_language,
        occurrenceCount: row.occurrence_count,
        recentOccurrenceCount: row.recent_occurrence_count,
        translationCount: row.occurrence_count,
        firstSeenAt: toIso(row.first_seen_at_ms),
        lastUsedAt: toIso(row.last_used_at_ms),
        context: row.context,
        quizIntervalDays: row.quiz_interval_days,
        nextDueAt: toIso(row.next_due_at_ms)
    };
}

function toHeatStatistic(row: EntryRow): HeatStatistic {
    return {
        sourceText: row.source_text,
        normalizedSource: row.normalized_source,
        translatedText: row.translated_text,
        sourceLanguage: row.source_language,
        targetLanguage: row.target_language,
        occurrenceCount: row.occurrence_count,
        recentOccurrenceCount: row.recent_occurrence_count,
        lastUsedAt: toIso(row.last_used_at_ms)
    };
}

function csvValue(value: string | number): string {
    return `"${String(value).replace(/"/gu, '""')}"`;
}

function exportRows(rows: EntryRow[], nowMs: number, format: 'json' | 'csv'): string {
    const entries = rows
        .map(toMemoryEntry)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (format === 'json') {
        return JSON.stringify({
            version: 1,
            exportedAt: toIso(nowMs),
            entries
        }, null, 2);
    }
    const header = [
        'id',
        'sourceText',
        'normalizedSource',
        'translatedText',
        'sourceLanguage',
        'targetLanguage',
        'occurrenceCount',
        'recentOccurrenceCount',
        'translationCount',
        'firstSeenAt',
        'lastUsedAt',
        'context',
        'quizIntervalDays',
        'nextDueAt'
    ];
    const lines = [header.join(',')];
    for (const entry of entries) {
        lines.push([
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
        ].map(csvValue).join(','));
    }
    return `${lines.join('\n')}\n`;
}

function updateEntry(
    database: DatabaseType,
    id: string,
    patch: WorkerEntryPatch
): boolean {
    const row = database.prepare('SELECT * FROM entries WHERE id = ?').get(id) as {
        source_text: string;
        normalized_source: string;
        translated_text: string;
        source_language: string;
        target_language: string;
        context: string;
        quiz_interval_days: number;
        next_due_at_ms: number;
    } | undefined;
    if (row === undefined)
        return false;
    const sourceText = patch.sourceText === undefined
        ? row.source_text
        : validateVocabularySourceText(patch.sourceText);
    const normalizedSource = normalizeSource(sourceText);
    const translatedText = patch.translatedText ?? row.translated_text;
    const sourceLanguage = normalizeLanguage(patch.sourceLanguage ?? row.source_language, 'unknown');
    const targetLanguage = normalizeLanguage(patch.targetLanguage ?? row.target_language, 'unknown');
    database.prepare(`
        UPDATE entries SET
            source_text = ?, normalized_source = ?, translated_text = ?,
            source_language = ?, target_language = ?, context = ?,
            quiz_interval_days = ?, next_due_at_ms = ?
        WHERE id = ?
    `).run(
        sourceText.trim(),
        normalizedSource,
        translatedText,
        sourceLanguage,
        targetLanguage,
        patch.context ?? row.context,
        patch.quizIntervalDays ?? row.quiz_interval_days,
        patch.nextDueAtMs ?? row.next_due_at_ms,
        id
    );
    return true;
}

function deleteEntries(database: DatabaseType, ids: string[]): number {
    const placeholders = ids.map(() => '?').join(',');
    return database.transaction(() => {
        const occurrenceChanges = database.prepare(
            `DELETE FROM occurrences WHERE entry_id IN (${placeholders})`
        ).run(...ids).changes;
        const entryChanges = database.prepare(
            `DELETE FROM entries WHERE id IN (${placeholders})`
        ).run(...ids).changes;
        return occurrenceChanges + entryChanges;
    })();
}

function handleRequest(database: DatabaseType, request: MemoryWorkerRequest): unknown {
    switch (request.operation) {
        case 'recordTranslations': {
            if (!memoryEnabled(database))
                return { recorded: 0 };
            const write = database.transaction((records: typeof request.records) => {
                for (const record of records)
                    writeRecord(database, record.task, record.recordedAtMs);
            });
            write(request.records);
            return { recorded: request.records.length };
        }
        case 'queryHeat': {
            const rows = queryEntries(database, request.filter, request.nowMs);
            return {
                statistics: rows
                    .map(toHeatStatistic)
                    .sort((left, right) => (
                        right.occurrenceCount - left.occurrenceCount
                        || right.recentOccurrenceCount - left.recentOccurrenceCount
                        || right.lastUsedAt.localeCompare(left.lastUsedAt)
                        || left.normalizedSource.localeCompare(right.normalizedSource)
                        || left.sourceLanguage.localeCompare(right.sourceLanguage)
                        || left.targetLanguage.localeCompare(right.targetLanguage)
                    ))
            };
        }
        case 'listEntries':
            return {
                entries: queryEntries(
                    database,
                    request.query,
                    request.nowMs,
                    request.query.search,
                    request.query.limit
                ).map(toMemoryEntry)
            };
        case 'updateEntry':
            return { updated: updateEntry(database, request.id, request.patch) };
        case 'deleteEntries':
            return { deleted: deleteEntries(database, request.ids) };
        case 'exportEntries':
            return {
                value: exportRows(
                    queryEntries(database, {}, request.nowMs),
                    request.nowMs,
                    request.format
                )
            };
        case 'setMemoryEnabled':
            database.prepare(`
                INSERT INTO metadata(key, value) VALUES ('memory_enabled', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `).run(request.enabled ? '1' : '0');
            return { enabled: request.enabled };
        case 'close':
            database.close();
            return null;
    }
}

function run(database: DatabaseType): void {
    if (parentPort === null)
        return;
    parentPort.on('message', (raw: unknown) => {
        const parsed = memoryWorkerRequestSchema.safeParse(raw);
        if (!parsed.success) {
            parentPort?.postMessage({
                requestId: (raw as { requestId?: string } | undefined)?.requestId ?? '',
                ok: false,
                error: { code: 'invalid-request', message: 'Invalid memory worker request.' }
            });
            return;
        }
        const request = parsed.data;
        try {
            const result = handleRequest(database, request);
            parentPort?.postMessage({
                requestId: request.requestId,
                ok: true,
                operation: request.operation,
                result
            });
            if (request.operation === 'close')
                parentPort?.close();
        } catch (error) {
            parentPort?.postMessage({
                requestId: request.requestId,
                ok: false,
                error: {
                    code: isUniqueConstraint(error)
                        ? 'conflict'
                        : isInputError(error) ? 'invalid-request' : 'internal',
                    message: error instanceof Error ? error.message.slice(0, 500) : 'Memory operation failed.'
                }
            });
        }
    });
}

const parsedOptions = databaseOptionsSchema.parse(workerData);
const database = new Database(parsedOptions.databasePath);
migrate(database, toIso(Date.now()));
run(database);
