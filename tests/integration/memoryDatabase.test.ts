import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MemoryDatabase,
    type MemoryDatabaseOptions
} from '../../src/main/services/memoryDatabase';
import type { TranslationTask } from '../../src/shared/contracts';

const workerPath = resolve(process.cwd(), 'out/main/memoryWorker.js');
const controlledWorkerPath = resolve(process.cwd(), 'tests/fixtures/memoryWorkerControl.mjs');
const sqliteFixturePath = resolve(process.cwd(), 'tests/fixtures/sqliteFixture.mjs');
const temporaryDirectories: string[] = [];
const openDatabases: MemoryDatabase[] = [];

function completedTask(overrides: Partial<TranslationTask> = {}): TranslationTask {
    const task: TranslationTask = {
        id: 'task-1',
        status: 'completed',
        kind: 'selection',
        sourceText: '  Hello   World  ',
        translatedText: '你好世界',
        sourceLanguage: 'EN-us',
        targetLanguage: 'zh-cn',
        retryInput: {
            kind: 'selection',
            strategy: 'reuse-source',
            sourceText: 'Hello World'
        },
        ...overrides
    };
    if (task.kind === 'selection') {
        task.retryInput = {
            kind: 'selection',
            strategy: 'reuse-source',
            sourceText: task.sourceText
        };
    } else {
        if (task.bounds === undefined)
            throw new Error('Screenshot fixtures require bounds.');
        task.retryInput = {
            kind: 'screenshot',
            strategy: 'recapture',
            bounds: task.bounds
        };
    }
    return task;
}

async function createMemory(
    initialNow = '2026-10-29T12:00:00.000Z',
    options: Partial<MemoryDatabaseOptions> = {}
) {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-pet-memory-'));
    temporaryDirectories.push(directory);
    const now = { value: new Date(initialNow) };
    const database = new MemoryDatabase({
        databasePath: join(directory, 'vocabulary-memory.sqlite3'),
        workerPath,
        now: () => now.value,
        ...options
    });
    openDatabases.push(database);
    return { database, directory, now };
}

function createVersion2Fixture(
    databasePath: string,
    options: { invalidOccurrence?: boolean } = {}
): void {
    runSqlite(databasePath, `
        PRAGMA journal_mode = WAL;
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at)
        VALUES (2, '2026-10-29T12:00:00.000Z');
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
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT INTO metadata(key, value) VALUES ('memory_enabled', '0');
        INSERT INTO entries(
            id, source_text, normalized_source, translated_text,
            source_language, target_language, first_seen_at_ms, last_used_at_ms,
            context, quiz_interval_days, next_due_at_ms
        ) VALUES (
            'stale-entry', 'STRASSE', 'strasse', 'Older translation',
            'EN-us', 'FR-fr', ${Date.parse('2026-10-01T00:00:00.000Z')},
            ${Date.parse('2026-10-03T00:00:00.000Z')}, '', 1,
            ${Date.parse('2026-10-04T00:00:00.000Z')}
        );
        INSERT INTO entries(
            id, source_text, normalized_source, translated_text,
            source_language, target_language, first_seen_at_ms, last_used_at_ms,
            context, quiz_interval_days, next_due_at_ms
        ) VALUES (
            'edited-entry', 'Straße', 'straße', 'Edited translation',
            'EN-us', 'FR-fr', ${Date.parse('2026-10-02T00:00:00.000Z')},
            ${Date.parse('2026-10-04T00:00:00.000Z')}, 'Edited context', 4,
            ${Date.parse('2026-10-08T00:00:00.000Z')}
        );
        INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
        VALUES ('stale-entry', 'stale-task', ${Date.parse('2026-10-01T00:00:00.000Z')});
        INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
        VALUES (
            'edited-entry', 'edited-task',
            ${options.invalidOccurrence === true
                ? "'invalid timestamp'"
                : Date.parse('2026-10-04T00:00:00.000Z')}
        );
    `);
}

function readVersion2Fixture(databasePath: string) {
    const entries = readSqliteJson(databasePath, `
        SELECT id, source_text, normalized_source, translated_text, context
        FROM entries ORDER BY id
    `) as Array<{
        id: string;
        source_text: string;
        normalized_source: string;
        translated_text: string;
        context: string;
    }>;
    const version = readSqliteJson(databasePath, `
        SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations
    `) as Array<{ version: number }>;
    return { entries, version: version[0]?.version ?? 0 };
}

function createCompetingEditsFixture(databasePath: string): void {
    runSqlite(databasePath, `
        PRAGMA journal_mode = WAL;
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at)
        VALUES (3, '2026-10-29T12:00:00.000Z');
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
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT INTO metadata(key, value) VALUES ('memory_enabled', '1');
        INSERT INTO entries VALUES (
            'edit-a', 'Straße', 'straße', 'Translation A', 'EN-us', 'FR-fr',
            ${Date.parse('2026-10-01T00:00:00.000Z')},
            ${Date.parse('2026-10-02T00:00:00.000Z')}, 'Note A', 2,
            ${Date.parse('2026-10-05T00:00:00.000Z')}
        );
        INSERT INTO entries VALUES (
            'edit-b', 'STRASSE', 'STRASSE', 'Translation B', 'EN-us', 'FR-fr',
            ${Date.parse('2026-10-02T00:00:00.000Z')},
            ${Date.parse('2026-10-04T00:00:00.000Z')}, 'Note B', 5,
            ${Date.parse('2026-10-08T00:00:00.000Z')}
        );
        INSERT INTO entries VALUES (
            'edit-c', 'strasse', 'Straße', 'Translation C', 'EN-us', 'FR-fr',
            ${Date.parse('2026-10-03T00:00:00.000Z')},
            ${Date.parse('2026-10-03T00:00:00.000Z')}, 'Note C', 3,
            ${Date.parse('2026-10-06T00:00:00.000Z')}
        );
        INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
        VALUES ('edit-a', 'task-a', ${Date.parse('2026-10-01T00:00:00.000Z')});
        INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
        VALUES ('edit-b', 'task-b', ${Date.parse('2026-10-04T00:00:00.000Z')});
        INSERT INTO occurrences(entry_id, task_id, occurred_at_ms)
        VALUES ('edit-c', 'task-c', ${Date.parse('2026-10-03T00:00:00.000Z')});
    `);
}

function createBatchRollbackFixture(databasePath: string): void {
    runSqlite(databasePath, `
        PRAGMA journal_mode = WAL;
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at)
        VALUES (4, '2026-10-29T12:00:00.000Z');
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
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT INTO metadata(key, value) VALUES ('memory_enabled', '1');
        CREATE TRIGGER reject_later_batch_record
        BEFORE INSERT ON occurrences
        WHEN NEW.task_id = 'rollback-fail'
        BEGIN
            SELECT RAISE(ABORT, 'synthetic occurrence failure');
        END;
    `);
}

function runSqlite(databasePath: string, sql: string): void {
    const result = spawnSync(process.execPath, [sqliteFixturePath, 'exec', databasePath], {
        encoding: 'utf8',
        input: sql
    });
    if (result.error !== undefined || result.status !== 0)
        throw new Error(result.stderr || result.error?.message || 'SQLite fixture failed.');
}

function readSqliteJson(databasePath: string, sql: string): unknown {
    const result = spawnSync(process.execPath, [sqliteFixturePath, 'query', databasePath], {
        encoding: 'utf8',
        input: sql
    });
    if (result.error !== undefined || result.status !== 0)
        throw new Error(result.stderr || result.error?.message || 'SQLite fixture read failed.');
    return JSON.parse(result.stdout || '[]');
}

afterEach(async () => {
    await Promise.all(openDatabases.splice(0).map((database) => database.close()));
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true
    })));
});

describe('MemoryDatabase', () => {
    it('uses Unicode case folding without Turkish dotted-I false equivalence', async () => {
        const { database } = await createMemory();
        await database.recordTranslation(completedTask({ id: 'sharp-s', sourceText: 'Straße' }));
        await database.recordTranslation(completedTask({ id: 'sharp-s-fold', sourceText: 'STRASSE' }));
        await database.recordTranslation(completedTask({ id: 'dotted-i', sourceText: 'İ', sourceLanguage: 'tr-TR' }));
        await database.recordTranslation(completedTask({ id: 'dotted-i-fold', sourceText: 'i̇', sourceLanguage: 'tr-TR' }));
        await database.recordTranslation(completedTask({ id: 'ascii-i', sourceText: 'I', sourceLanguage: 'tr-TR' }));
        await database.recordTranslation(completedTask({ id: 'dotless-i', sourceText: 'ı', sourceLanguage: 'tr-TR' }));

        const entries = await database.listEntries();
        expect(entries.find((entry) => entry.normalizedSource === 'strasse')).toMatchObject({
            occurrenceCount: 2
        });
        expect(entries.find((entry) => entry.normalizedSource === 'i̇')).toMatchObject({
            occurrenceCount: 2
        });
        expect(entries.filter((entry) => entry.normalizedSource === 'i')).toHaveLength(1);
        expect(entries.filter((entry) => entry.normalizedSource === 'ı')).toHaveLength(1);
    });

    it('normalizes offset filter bounds to epoch milliseconds', async () => {
        const { database, now } = await createMemory('2026-10-29T01:30:00.000Z');
        now.value = new Date('2026-10-29T00:30:00.000Z');
        await database.recordTranslation(completedTask({ id: 'offset-boundary' }));
        now.value = new Date('2026-10-29T01:30:00.000Z');

        await expect(database.queryHeat({
            from: '2026-10-29T01:00:00.000+02:00',
            to: '2026-10-29T03:00:00.000+02:00'
        })).resolves.toHaveLength(1);
        await expect(database.queryHeat({
            from: '2026-10-29T03:00:00.000+02:00',
            to: '2026-10-29T04:00:00.000+02:00'
        })).resolves.toHaveLength(0);
    });

    it.each([
        ['data URL', 'data:image/png;base64,AAAA'],
        ['MIME-less data URL', 'data:,AAAA'],
        ['case and whitespace varied data URL', ' DaTa : , AAAA '],
        ['base64 data URL', 'data:;base64,QUJDRA=='],
        ['base64 payload', 'QmFzZTY0UGF5bG9hZEJhc2U2NFBheWxvYWRCYXNlNjRQYXlsb2FkQmFzZTY0UGF5bG9hZA=='],
        ['base64 fragment', 'base64,AAAA'],
        ['capture placeholder', 'Screenshot region:'],
        ['punctuation-wrapped placeholder', '[SCREENSHOT REGION]!'],
        ['redacted capture placeholder', 'Screenshot region (redacted)'],
        [
            'standard base64 wrapped across 16-character chunks',
            'ZGF0YTosQUFBQUFB QUFBQUFBQUFBQUFB QUFBQUFBQUFBQUFB'
        ],
        ['short padded encoded token', 'QUJDRA=='],
        ['long unspaced payload', 'A'.repeat(80)]
    ])('rejects %s before queueing memory records', async (_kind, sourceText) => {
        const { database } = await createMemory();
        await expect(database.recordTranslation(completedTask({
            id: 'capture-payload',
            sourceText
        }))).rejects.toMatchObject({ code: 'invalid-request' });
        await expect(database.listEntries()).resolves.toEqual([]);
    });

    it.each([
        ['technical MIME text', 'text/plain, UTF-8'],
        [
            'long natural-language sentence with short words',
            'Please bring the signed application form to the reception desk before Friday morning today.'
        ]
    ])('queues %s from ordinary OCR', async (_kind, sourceText) => {
        const { database } = await createMemory();
        await database.recordTranslation(completedTask({
            id: 'ordinary-ocr',
            sourceText
        }));
        await expect(database.listEntries()).resolves.toMatchObject([{
            sourceText
        }]);
    });

    it.each([
        ['MIME-less data URL', 'data:,AAAA'],
        ['capture placeholder', 'Screenshot region:'],
        ['short padded encoded token', 'QUJDRA=='],
        ['long unspaced payload', 'A'.repeat(80)]
    ])('rejects %s when updating an entry at the worker boundary', async (_kind, sourceText) => {
        const { database } = await createMemory();
        await database.recordTranslation(completedTask());
        const [entry] = await database.listEntries();
        if (entry === undefined)
            throw new Error('Expected an entry to update.');
        await expect(database.updateEntry(entry.id, {
            sourceText
        })).rejects.toMatchObject({ code: 'invalid-request' });
        await expect(database.listEntries()).resolves.toMatchObject([{
            id: entry.id,
            sourceText: 'Hello   World'
        }]);
    });

    it('deduplicates normalized repeats per task and keeps a stable entry ID', async () => {
        const { database, now } = await createMemory();
        await database.recordTranslation(completedTask({ id: 'task-a', sourceText: '  HELLO\t World ' }));
        const first = await database.listEntries();
        now.value = new Date('2026-10-29T12:05:00.000Z');
        await database.recordTranslation(completedTask({ id: 'task-b', sourceText: 'hello   WORLD', sourceLanguage: 'en-US' }));
        await database.recordTranslation(completedTask({ id: 'task-b', sourceText: 'hello   WORLD', sourceLanguage: 'en-US' }));
        const second = await database.listEntries();
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({
            id: first[0].id,
            sourceText: 'HELLO\t World',
            normalizedSource: 'hello world',
            sourceLanguage: 'en-US',
            targetLanguage: 'zh-CN',
            occurrenceCount: 2,
            recentOccurrenceCount: 2,
            translationCount: 2,
            firstSeenAt: '2026-10-29T12:00:00.000Z',
            lastUsedAt: '2026-10-29T12:05:00.000Z'
        });
    });

    it('computes rolling seven-day counts at query time and applies language/time filters', async () => {
        const { database, now } = await createMemory('2026-10-29T12:00:00.000Z');
        for (const [id, recordedAt] of [
            ['old', '2026-10-22T11:59:59.000Z'],
            ['edge', '2026-10-22T12:00:00.000Z'],
            ['recent', '2026-10-28T12:00:00.000Z']
        ] as const) {
            now.value = new Date(recordedAt);
            await database.recordTranslation(completedTask({ id, sourceText: 'Repeated phrase', sourceLanguage: 'en-US', targetLanguage: 'ja-JP' }));
        }
        now.value = new Date('2026-10-27T00:00:00.000Z');
        await database.recordTranslation(completedTask({ id: 'other-language', sourceText: 'Autre phrase', sourceLanguage: 'fr-FR', targetLanguage: 'en-US' }));
        now.value = new Date('2026-10-29T12:00:00.000Z');
        const heat = await database.queryHeat();
        expect(heat.find((item) => item.normalizedSource === 'repeated phrase')).toMatchObject({ occurrenceCount: 3, recentOccurrenceCount: 2, lastUsedAt: '2026-10-28T12:00:00.000Z' });
        await expect(database.queryHeat({ sourceLanguage: 'en-US', targetLanguage: 'ja-JP', from: '2026-10-23T00:00:00.000Z', to: '2026-10-28T23:59:59.999Z' })).resolves.toMatchObject([{ normalizedSource: 'repeated phrase', occurrenceCount: 3, recentOccurrenceCount: 2 }]);
        await expect(database.queryHeat({ sourceLanguage: 'fr-FR', from: '2026-10-23T00:00:00.000Z', to: '2026-10-28T23:59:59.999Z' })).resolves.toMatchObject([{ normalizedSource: 'autre phrase', occurrenceCount: 1, recentOccurrenceCount: 1 }]);
        await expect(database.queryHeat({ sourceLanguage: 'en-US', from: '2026-10-23T00:00:00.000Z', to: '2026-10-28T23:59:59.999Z' })).resolves.toHaveLength(1);
    });

    it('pauses recording without deleting history and persists the pause', async () => {
        const first = await createMemory();
        await first.database.recordTranslation(completedTask({ id: 'before-pause' }));
        await first.database.setMemoryEnabled(false);
        first.now.value = new Date('2026-10-29T12:10:00.000Z');
        await first.database.recordTranslation(completedTask({ id: 'while-paused' }));
        expect(await first.database.listEntries()).toMatchObject([{ occurrenceCount: 1, lastUsedAt: '2026-10-29T12:00:00.000Z' }]);
        await first.database.close();
        openDatabases.splice(openDatabases.indexOf(first.database), 1);
        const second = new MemoryDatabase({
            databasePath: join(first.directory, 'vocabulary-memory.sqlite3'),
            workerPath,
            now: () => first.now.value
        });
        openDatabases.push(second);
        await second.recordTranslation(completedTask({ id: 'still-paused' }));
        expect(await second.listEntries()).toHaveLength(1);
        await second.setMemoryEnabled(true);
        first.now.value = new Date('2026-10-29T12:20:00.000Z');
        await second.recordTranslation(completedTask({ id: 'resumed' }));
        expect(await second.listEntries()).toMatchObject([{ occurrenceCount: 2, recentOccurrenceCount: 2 }]);
    });

    it('edits entries, rolls back identity conflicts, and exports deterministic JSON/CSV', async () => {
        const { database } = await createMemory();
        await database.recordTranslation(completedTask({ id: 'first', sourceText: 'Alpha', translatedText: 'Alpha translation' }));
        await database.recordTranslation(completedTask({ id: 'second', sourceText: 'Beta', translatedText: 'Beta translation' }));
        const before = await database.listEntries();
        const alpha = before.find((entry) => entry.normalizedSource === 'alpha');
        const beta = before.find((entry) => entry.normalizedSource === 'beta');
        if (alpha === undefined || beta === undefined)
            throw new Error('Expected alpha and beta entries.');
        await database.updateEntry(alpha.id, {
            sourceText: 'Alpha edited',
            translatedText: 'Corrected translation',
            context: 'Synthetic context',
            quizIntervalDays: 3,
            nextDueAt: '2026-11-01T12:00:00.000Z'
        });
        expect(await database.listEntries({ search: 'corrected' })).toMatchObject([{
            id: alpha.id,
            sourceText: 'Alpha edited',
            normalizedSource: 'alpha edited',
            translatedText: 'Corrected translation',
            context: 'Synthetic context',
            quizIntervalDays: 3,
            nextDueAt: '2026-11-01T12:00:00.000Z'
        }]);
        await expect(database.updateEntry(alpha.id, { sourceText: 'Beta', translatedText: 'must roll back' })).rejects.toMatchObject({ code: 'conflict' });
        expect((await database.listEntries({ search: 'alpha edited' }))[0]).toMatchObject({ translatedText: 'Corrected translation', context: 'Synthetic context' });
        const firstJson = await database.exportEntries('json');
        expect(await database.exportEntries('json')).toBe(firstJson);
        const exported = JSON.parse(firstJson) as { version: number; exportedAt: string; entries: { id: string }[] };
        expect(exported.version).toBe(1);
        expect(exported.exportedAt).toBe('2026-10-29T12:00:00.000Z');
        expect(exported.entries.map((entry) => entry.id)).toEqual(exported.entries.map((entry) => entry.id).slice().sort());
        const csv = await database.exportEntries('csv');
        const lines = csv.trimEnd().split('\n');
        expect(lines[0]).toBe(['id', 'sourceText', 'normalizedSource', 'translatedText', 'sourceLanguage', 'targetLanguage', 'occurrenceCount', 'recentOccurrenceCount', 'translationCount', 'firstSeenAt', 'lastUsedAt', 'context', 'quizIntervalDays', 'nextDueAt'].join(','));
        expect(lines).toHaveLength(3);
        expect(csv).toContain('Corrected translation');
        expect(await database.exportEntries('csv')).toBe(csv);
    });

    it('deletes entries and every occurrence transactionally', async () => {
        const { database } = await createMemory();
        const task = completedTask({ id: 'delete-me' });
        await database.recordTranslation(task);
        await database.recordTranslation(completedTask({ id: 'keep-me', sourceText: 'Keep' }));
        const before = await database.listEntries();
        const deleted = before.find((entry) => entry.normalizedSource === 'hello world');
        if (deleted === undefined)
            throw new Error('Expected an entry to delete.');
        await database.deleteEntries([deleted.id]);
        expect(await database.listEntries()).toMatchObject([{ normalizedSource: 'keep', occurrenceCount: 1 }]);
        await database.recordTranslation(task);
        expect(await database.listEntries({ search: 'hello world' })).toMatchObject([{ id: deleted.id, occurrenceCount: 1, recentOccurrenceCount: 1 }]);
    });

    it('rolls back earlier records when a later batched occurrence fails', async () => {
        const { database, directory } = await createMemory();
        const databasePath = join(directory, 'vocabulary-memory.sqlite3');
        createBatchRollbackFixture(databasePath);
        const writes = [
            database.recordTranslation(completedTask({ id: 'rollback-keep', sourceText: 'Keep' })),
            database.recordTranslation(completedTask({ id: 'rollback-fail', sourceText: 'Fail' }))
        ];

        const results = await Promise.allSettled(writes);
        expect(results[0].status).toBe('rejected');
        expect(results[1].status).toBe('rejected');
        await expect(database.listEntries()).resolves.toEqual([]);
    });

    it('rejects saturated record queues with a recoverable busy code', async () => {
        const { database } = await createMemory('2026-10-29T12:00:00.000Z', {
            maxQueuedRecords: 2
        });
        const writes = [
            database.recordTranslation(completedTask({ id: 'queued-1', sourceText: 'One' })),
            database.recordTranslation(completedTask({ id: 'queued-2', sourceText: 'Two' })),
            database.recordTranslation(completedTask({ id: 'queued-3', sourceText: 'Three' }))
        ];

        const results = await Promise.allSettled(writes);
        expect(results.slice(0, 2).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(results[2]).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ code: 'busy' })
        });
    });

    it('counts in-flight record batches toward saturation and recovers after worker timeout', async () => {
        let factoryCalls = 0;
        const { database } = await createMemory('2026-10-29T12:00:00.000Z', {
            requestTimeoutMs: 250,
            maxQueuedRecords: 1,
            workerFactory: (filename, options) => {
                factoryCalls += 1;
                return factoryCalls === 1
                    ? new Worker(controlledWorkerPath, { workerData: { mode: 'hang' } })
                    : new Worker(filename, options);
            }
        });

        const first = database.recordTranslation(completedTask({ id: 'in-flight', sourceText: 'One' }));
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        await expect(database.recordTranslation(completedTask({
            id: 'saturated',
            sourceText: 'Two'
        }))).rejects.toMatchObject({ code: 'busy' });
        await expect(first).rejects.toMatchObject({ code: 'timeout' });
        await expect(database.recordTranslation(completedTask({
            id: 'after-recycle',
            sourceText: 'Three'
        }))).resolves.toBeUndefined();
        expect(factoryCalls).toBeGreaterThanOrEqual(2);
    });

    it('times out hung requests, rejects pending work, and recycles the worker', async () => {
        let factoryCalls = 0;
        const { database } = await createMemory('2026-10-29T12:00:00.000Z', {
            requestTimeoutMs: 250,
            workerFactory: (filename, options) => {
                factoryCalls += 1;
                return factoryCalls === 1
                    ? new Worker(controlledWorkerPath, { workerData: { mode: 'hang' } })
                    : new Worker(filename, options);
            }
        });
        const pending = [database.listEntries(), database.listEntries()];
        const results = await Promise.allSettled(pending);
        expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
        for (const result of results) {
            if (result.status === 'rejected')
                expect(result.reason).toMatchObject({ code: 'timeout' });
        }
        await expect(database.listEntries()).resolves.toEqual([]);
        expect(factoryCalls).toBeGreaterThanOrEqual(2);
    });

    it('rejects crashed workers safely and recreates the worker on the next request', async () => {
        let factoryCalls = 0;
        const { database } = await createMemory('2026-10-29T12:00:00.000Z', {
            workerFactory: (filename, options) => {
                factoryCalls += 1;
                return factoryCalls === 1
                    ? new Worker(controlledWorkerPath, { workerData: { mode: 'crash' } })
                    : new Worker(filename, options);
            }
        });

        await expect(database.listEntries()).rejects.toMatchObject({ code: 'worker' });
        await expect(database.listEntries()).resolves.toEqual([]);
        expect(factoryCalls).toBeGreaterThanOrEqual(2);
    });

    it('reconciles stale Unicode identities and merges duplicates without losing edits or pause state', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'desktop-pet-memory-migration-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'vocabulary-memory.sqlite3');
        createVersion2Fixture(databasePath);
        const database = new MemoryDatabase({
            databasePath,
            workerPath,
            now: () => new Date('2026-10-29T12:00:00.000Z')
        });
        openDatabases.push(database);

        const entries = await database.listEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            sourceText: 'Straße',
            normalizedSource: 'strasse',
            translatedText: 'Edited translation',
            sourceLanguage: 'en-US',
            targetLanguage: 'fr-FR',
            firstSeenAt: '2026-10-01T00:00:00.000Z',
            lastUsedAt: '2026-10-04T00:00:00.000Z',
            context: 'Edited context',
            quizIntervalDays: 4,
            nextDueAt: '2026-10-08T00:00:00.000Z',
            occurrenceCount: 2
        });

        await expect(database.recordTranslation(completedTask({
            id: 'paused-task',
            sourceText: 'Another source'
        }))).resolves.toBeUndefined();
        expect(await database.listEntries()).toHaveLength(1);
    });

    it('preserves competing reconciliation edits with deterministic precedence and history', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'desktop-pet-memory-competing-edits-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'vocabulary-memory.sqlite3');
        createCompetingEditsFixture(databasePath);
        const database = new MemoryDatabase({
            databasePath,
            workerPath,
            now: () => new Date('2026-10-29T12:00:00.000Z')
        });
        openDatabases.push(database);

        const entries = await database.listEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            sourceText: 'STRASSE',
            normalizedSource: 'strasse',
            translatedText: 'Translation B',
            sourceLanguage: 'en-US',
            targetLanguage: 'fr-FR',
            firstSeenAt: '2026-10-01T00:00:00.000Z',
            lastUsedAt: '2026-10-04T00:00:00.000Z',
            context: 'Note B',
            quizIntervalDays: 5,
            nextDueAt: '2026-10-08T00:00:00.000Z',
            occurrenceCount: 3
        });
        await database.close();
        const history = readSqliteJson(databasePath, `
            SELECT snapshot_json FROM entry_merge_history ORDER BY entry_id
        `) as Array<{ snapshot_json: string }>;
        const snapshots = history.map((row) => JSON.parse(row.snapshot_json) as {
            id: string;
            source_text: string;
            translated_text: string;
            context: string;
            quiz_interval_days: number;
            next_due_at_ms: number;
        });
        expect(snapshots).toMatchObject([
            {
                id: 'edit-a',
                source_text: 'Straße',
                translated_text: 'Translation A',
                context: 'Note A',
                quiz_interval_days: 2,
                next_due_at_ms: Date.parse('2026-10-05T00:00:00.000Z')
            },
            {
                id: 'edit-b',
                source_text: 'STRASSE',
                translated_text: 'Translation B',
                context: 'Note B',
                quiz_interval_days: 5,
                next_due_at_ms: Date.parse('2026-10-08T00:00:00.000Z')
            },
            {
                id: 'edit-c',
                source_text: 'strasse',
                translated_text: 'Translation C',
                context: 'Note C',
                quiz_interval_days: 3,
                next_due_at_ms: Date.parse('2026-10-06T00:00:00.000Z')
            }
        ]);
    });

    it('rolls back duplicate reconciliation when a later occurrence fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'desktop-pet-memory-migration-rollback-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'vocabulary-memory.sqlite3');
        createVersion2Fixture(databasePath, { invalidOccurrence: true });
        const database = new MemoryDatabase({
            databasePath,
            workerPath,
            now: () => new Date('2026-10-29T12:00:00.000Z')
        });
        openDatabases.push(database);

        await expect(database.listEntries()).rejects.toMatchObject({ code: 'worker' });
        await database.close();
        const fixture = readVersion2Fixture(databasePath);
        expect(fixture.version).toBe(2);
        expect(fixture.entries.map((entry) => entry.normalized_source)).toEqual([
            'straße',
            'strasse'
        ]);
    });

    it('stores only allowlisted vocabulary fields and never provider or capture payloads', async () => {
        const { database, directory } = await createMemory();
        await database.recordTranslation({
            ...completedTask({
                id: 'private-task',
                kind: 'screenshot',
                sourceText: 'Hello world',
                sourceLanguage: 'und',
                bounds: { x: 1234, y: 5678, width: 640, height: 480 },
                providerId: 'SECRET_PROVIDER_ID',
                providerName: 'SECRET_PROVIDER_NAME',
                textModel: 'SECRET_TEXT_MODEL',
                visionModel: 'SECRET_VISION_MODEL',
                translationModel: 'SECRET_TRANSLATION_MODEL'
            })
        });
        const exported = await database.exportEntries('json');
        for (const secret of ['SECRET_PROVIDER_ID', 'SECRET_PROVIDER_NAME', 'SECRET_TEXT_MODEL', 'SECRET_VISION_MODEL', 'SECRET_TRANSLATION_MODEL', 'dataUrl', 'bounds'])
            expect(exported).not.toContain(secret);
        await database.close();
        const databaseFiles = await Promise.all([
            readFile(join(directory, 'vocabulary-memory.sqlite3')),
            readFile(join(directory, 'vocabulary-memory.sqlite3-wal')).catch(() => Buffer.alloc(0))
        ]);
        const raw = Buffer.concat(databaseFiles).toString('latin1');
        for (const secret of ['SECRET_PROVIDER_ID', 'SECRET_PROVIDER_NAME', 'SECRET_TEXT_MODEL', 'SECRET_VISION_MODEL', 'SECRET_TRANSLATION_MODEL'])
            expect(raw).not.toContain(secret);
    });
});
