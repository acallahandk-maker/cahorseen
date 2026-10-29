import { createHash, randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
    type HeatStatistic,
    type MemoryEntry,
    type TranslationTask
} from '../../shared/contracts';
import {
    memoryWorkerRequestSchema,
    type MemoryEntryPatch,
    type MemoryFilter,
    type MemoryWorkerRequest
} from '../services/memoryDatabase';

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
    first_seen_at: string;
    last_used_at: string;
    context: string;
    quiz_interval_days: number;
    next_due_at: string;
    occurrence_count: number;
    recent_occurrence_count: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * DAY_MS;

function normalizeSource(value: string): string {
    const normalized = value
        .normalize('NFKC')
        .trim()
        .replace(/\s+/gu, ' ')
        .toLowerCase();
    if (normalized.length === 0)
        throw new Error('source text must contain non-whitespace characters');
    return normalized;
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

function toIso(value: Date): string {
    return value.toISOString();
}

function addDays(value: string, days: number): string {
    return toIso(new Date(Date.parse(value) + days * DAY_MS));
}

function isUniqueConstraint(error: unknown): boolean {
    return error instanceof Error
        && (error.message.includes('UNIQUE') || error.message.includes('constraint failed'));
}

function migrate(database: DatabaseType, now: string): void {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    `);
    const current = database.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
    ).get() as { version: number };
    if (current.version < 1) {
        database.transaction(() => {
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
                CREATE INDEX IF NOT EXISTS idx_entries_normalized_source
                    ON entries(normalized_source);
                CREATE INDEX IF NOT EXISTS idx_entries_language_timestamps
                    ON entries(source_language, target_language, last_used_at);
                CREATE INDEX IF NOT EXISTS idx_entries_last_used_at
                    ON entries(last_used_at);
                CREATE INDEX IF NOT EXISTS idx_occurrences_entry_time
                    ON occurrences(entry_id, occurred_at);
                CREATE INDEX IF NOT EXISTS idx_occurrences_time
                    ON occurrences(occurred_at);
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR IGNORE INTO metadata(key, value) VALUES ('memory_enabled', '1');
                INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${now}');
            `);
        })();
    }
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
    recordedAt: string
): void {
    const normalizedSource = normalizeSource(task.sourceText);
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
        SELECT first_seen_at, last_used_at
        FROM entries WHERE id = ?
    `).get(id) as { first_seen_at: string; last_used_at: string } | undefined;
    if (previous === undefined) {
        database.prepare(`
            INSERT INTO entries (
                id, source_text, normalized_source, translated_text,
                source_language, target_language, first_seen_at, last_used_at,
                context, quiz_interval_days, next_due_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
            id,
            task.sourceText.trim(),
            normalizedSource,
            task.translatedText,
            sourceLanguage,
            targetLanguage,
            recordedAt,
            recordedAt,
            '',
            addDays(recordedAt, 1)
        );
    } else {
        database.prepare(`
            UPDATE entries SET
                first_seen_at = CASE WHEN ? < first_seen_at THEN ? ELSE first_seen_at END,
                last_used_at = CASE WHEN ? > last_used_at THEN ? ELSE last_used_at END,
                translated_text = CASE WHEN ? >= last_used_at THEN ? ELSE translated_text END,
                context = CASE WHEN ? >= last_used_at THEN ? ELSE context END
            WHERE id = ?
        `).run(
            recordedAt,
            recordedAt,
            recordedAt,
            recordedAt,
            recordedAt,
            task.translatedText,
            recordedAt,
            '',
            id
        );
    }
    database.prepare(`
        INSERT INTO occurrences(entry_id, task_id, occurred_at)
        VALUES (?, ?, ?)
        ON CONFLICT(entry_id, task_id) DO NOTHING
    `).run(id, task.id, recordedAt);
}

function filterSql(filter: MemoryFilter): { sql: string; parameters: string[] } {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filter.sourceLanguage !== undefined) {
        clauses.push('e.source_language = ?');
        parameters.push(normalizeLanguage(filter.sourceLanguage, 'unknown'));
    }
    if (filter.targetLanguage !== undefined) {
        clauses.push('e.target_language = ?');
        parameters.push(normalizeLanguage(filter.targetLanguage, 'unknown'));
    }
    if (filter.from !== undefined || filter.to !== undefined) {
        const bounds: string[] = [];
        if (filter.from !== undefined) {
            bounds.push('filter_occurrences.occurred_at >= ?');
            parameters.push(filter.from);
        }
        if (filter.to !== undefined) {
            bounds.push('filter_occurrences.occurred_at <= ?');
            parameters.push(filter.to);
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
    filter: MemoryFilter,
    now: string,
    search?: string,
    limit?: number
): EntryRow[] {
    const filterPart = filterSql(filter);
    const clauses = filterPart.sql === '' ? [] : [filterPart.sql.slice(6)];
    const parameters = [...filterPart.parameters];
    if (search !== undefined && search.length > 0) {
        clauses.push(`(
            e.normalized_source LIKE ?
            OR LOWER(e.source_text) LIKE ?
            OR LOWER(e.translated_text) LIKE ?
        )`);
        const term = `%${normalizeSource(search)}%`;
        parameters.push(term, term, term);
    }
    const recentStart = toIso(new Date(Date.parse(now) - RECENT_WINDOW_MS));
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = database.prepare(`
        SELECT e.*,
            (SELECT COUNT(*) FROM occurrences count_occurrences
             WHERE count_occurrences.entry_id = e.id) AS occurrence_count,
            (SELECT COUNT(*) FROM occurrences recent_occurrences
             WHERE recent_occurrences.entry_id = e.id
               AND recent_occurrences.occurred_at >= ?
               AND recent_occurrences.occurred_at <= ?) AS recent_occurrence_count
        FROM entries e
        ${where}
        ORDER BY e.last_used_at DESC, e.id ASC
        ${limit === undefined ? '' : 'LIMIT ?'}
    `).all(
        recentStart,
        now,
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
        firstSeenAt: row.first_seen_at,
        lastUsedAt: row.last_used_at,
        context: row.context,
        quizIntervalDays: row.quiz_interval_days,
        nextDueAt: row.next_due_at
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
        lastUsedAt: row.last_used_at
    };
}

function csvValue(value: string | number): string {
    return `"${String(value).replace(/"/gu, '""')}"`;
}

function exportRows(rows: EntryRow[], now: string, format: 'json' | 'csv'): string {
    const entries = rows
        .map(toMemoryEntry)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (format === 'json') {
        return JSON.stringify({
            version: 1,
            exportedAt: now,
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
    patch: MemoryEntryPatch
): boolean {
    const row = database.prepare('SELECT * FROM entries WHERE id = ?').get(id) as {
        source_text: string;
        normalized_source: string;
        translated_text: string;
        source_language: string;
        target_language: string;
        context: string;
        quiz_interval_days: number;
        next_due_at: string;
    } | undefined;
    if (row === undefined)
        return false;
    const sourceText = patch.sourceText ?? row.source_text;
    const normalizedSource = normalizeSource(sourceText);
    const translatedText = patch.translatedText ?? row.translated_text;
    const sourceLanguage = normalizeLanguage(patch.sourceLanguage ?? row.source_language, 'unknown');
    const targetLanguage = normalizeLanguage(patch.targetLanguage ?? row.target_language, 'unknown');
    database.prepare(`
        UPDATE entries SET
            source_text = ?, normalized_source = ?, translated_text = ?,
            source_language = ?, target_language = ?, context = ?,
            quiz_interval_days = ?, next_due_at = ?
        WHERE id = ?
    `).run(
        sourceText.trim(),
        normalizedSource,
        translatedText,
        sourceLanguage,
        targetLanguage,
        patch.context ?? row.context,
        patch.quizIntervalDays ?? row.quiz_interval_days,
        patch.nextDueAt ?? row.next_due_at,
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
                    writeRecord(database, record.task, record.recordedAt);
            });
            write(request.records);
            return { recorded: request.records.length };
        }
        case 'queryHeat': {
            const rows = queryEntries(database, request.filter, request.now);
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
                    request.now,
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
                    queryEntries(database, {}, request.now),
                    request.now,
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
                    code: isUniqueConstraint(error) ? 'conflict' : 'internal',
                    message: error instanceof Error ? error.message.slice(0, 500) : 'Memory operation failed.'
                }
            });
        }
    });
}

const parsedOptions = databaseOptionsSchema.parse(workerData);
const database = new Database(parsedOptions.databasePath);
migrate(database, toIso(new Date()));
run(database);
