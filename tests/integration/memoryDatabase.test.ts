import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
        const { database } = await createMemory();
        const writes = [
            database.recordTranslation(completedTask({ id: 'rollback-keep', sourceText: 'Keep' })),
            database.recordTranslation(completedTask({ id: 'rollback-fail', sourceText: '   ' }))
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

    it('stores only allowlisted vocabulary fields and never provider or capture payloads', async () => {
        const { database, directory } = await createMemory();
        await database.recordTranslation({
            ...completedTask({
                id: 'private-task',
                kind: 'screenshot',
                sourceText: 'Screenshot region',
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
        const databaseFiles = await Promise.all([
            readFile(join(directory, 'vocabulary-memory.sqlite3')),
            readFile(join(directory, 'vocabulary-memory.sqlite3-wal')).catch(() => Buffer.alloc(0))
        ]);
        const raw = Buffer.concat(databaseFiles).toString('latin1');
        for (const secret of ['SECRET_PROVIDER_ID', 'SECRET_PROVIDER_NAME', 'SECRET_TEXT_MODEL', 'SECRET_VISION_MODEL', 'SECRET_TRANSLATION_MODEL'])
            expect(raw).not.toContain(secret);
    });
});
