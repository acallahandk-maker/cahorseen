import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerIpcRouter, type IpcMainLike } from '../../src/main/ipcRouter';
import {
    MemoryDatabase,
    MemoryDatabaseError
} from '../../src/main/services/memoryDatabase';
import {
    createVocabularyApi,
    VocabularyExportSizeError
} from '../../src/preload/vocabularyAdapter';
import {
    MAX_VOCABULARY_EXPORT_CHARS,
    type TranslationTask,
    type VocabularyRepositoryFacade
} from '../../src/shared/contracts';

const workerPath = resolve(process.cwd(), 'out/main/memoryWorker.js');
const temporaryDirectories: string[] = [];
const openDatabases: MemoryDatabase[] = [];

function completedTask(overrides: Partial<TranslationTask> = {}): TranslationTask {
    return {
        id: 'task-1',
        status: 'completed',
        kind: 'selection',
        sourceText: 'Hello World',
        translatedText: '你好世界',
        sourceLanguage: 'en-US',
        targetLanguage: 'zh-CN',
        retryInput: {
            kind: 'selection',
            strategy: 'reuse-source',
            sourceText: 'Hello World'
        },
        ...overrides
    };
}

afterEach(async () => {
    await Promise.all(openDatabases.splice(0).map((database) => database.close()));
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
        rm(directory, { recursive: true, force: true })
    )));
});

describe('vocabulary IPC repository adapter', () => {
    it('round-trips the real Task 8 repository contract and export bytes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'desktop-pet-vocabulary-ipc-'));
        temporaryDirectories.push(directory);
        const now = new Date('2026-10-29T12:00:00.000Z');
        const database = new MemoryDatabase({
            databasePath: join(directory, 'vocabulary.sqlite3'),
            workerPath,
            now: () => now
        });
        openDatabases.push(database);
        await database.recordTranslation(completedTask());
        await database.recordTranslation(completedTask({
            id: 'task-2',
            sourceText: 'Hello Again',
            translatedText: '你好呀',
            retryInput: {
                kind: 'selection',
                strategy: 'reuse-source',
                sourceText: 'Hello Again'
            }
        }));

        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain: IpcMainLike = {
            handle: (channel, listener) => handlers.set(channel, listener),
            removeHandler: (channel) => void handlers.delete(channel)
        };
        const unregister = registerIpcRouter({
            ipcMain,
            secureConfig: {
                saveProvider: async () => {
                    throw new Error('not used');
                },
                setActiveProvider: async () => undefined,
                getProviderSummaries: async () => [],
                testProvider: async () => {
                    throw new Error('not used');
                }
            },
            memory: database,
            isSenderAuthorized: () => true
        });
        const api = createVocabularyApi(async (channel, payload) => {
            const handler = handlers.get(channel);
            if (handler === undefined)
                throw new Error(`Missing IPC handler: ${channel}`);
            return handler({}, payload);
        });

        const statistics = await api.queryHeat({
            sourceLanguage: 'en-US',
            targetLanguage: 'zh-CN',
            from: '2026-10-01T00:00:00.000Z'
        });
        const entries = await api.listEntries({ search: 'hello' });
        expect(statistics).toHaveLength(2);
        expect(entries.map((entry) => entry.sourceText).sort()).toEqual([
            'Hello Again',
            'Hello World'
        ]);

        const [first] = entries;
        if (first === undefined)
            throw new Error('Expected vocabulary entry.');
        await api.updateEntry(first.id, {
            sourceText: 'Hello Updated',
            translatedText: '你好更新',
            sourceLanguage: 'en-US',
            targetLanguage: 'zh-CN',
            context: 'Updated context',
            quizIntervalDays: 7,
            nextDueAt: '2026-11-05T12:00:00.000Z'
        });
        const [updated] = await api.listEntries({ search: 'updated' });
        expect(updated).toMatchObject({
            sourceText: 'Hello Updated',
            normalizedSource: 'hello updated',
            translatedText: '你好更新',
            sourceLanguage: 'en-US',
            targetLanguage: 'zh-CN',
            context: 'Updated context',
            quizIntervalDays: 7,
            nextDueAt: '2026-11-05T12:00:00.000Z'
        });

        expect(await api.exportEntries('json')).toBe(await database.exportEntries('json'));
        expect(await api.exportEntries('csv')).toBe(await database.exportEntries('csv'));
        expect(await api.getMemoryEnabled()).toBe(true);

        await api.deleteEntries([first.id]);
        expect((await api.listEntries({ search: 'updated' })).some((entry) => (
            entry.id === first.id
        ))).toBe(false);

        await api.setMemoryEnabled(false);
        expect(await api.getMemoryEnabled()).toBe(false);
        await database.recordTranslation(completedTask({
            id: 'task-disabled',
            sourceText: 'Disabled memory',
            retryInput: {
                kind: 'selection',
                strategy: 'reuse-source',
                sourceText: 'Disabled memory'
            }
        }));
        expect((await api.listEntries({ search: 'disabled' }))).toHaveLength(0);
        unregister();
    });

    it('preserves safe memory failure codes/messages and typed export failures across IPC', async () => {
        const cases = [
            ['busy', 'Translation memory is busy.'],
            ['conflict', 'Vocabulary entry conflicts with existing data.'],
            ['internal', 'Vocabulary operation failed.'],
            ['invalid-request', 'Vocabulary request is invalid.'],
            ['not-found', 'Vocabulary entry was not found.'],
            ['storage', 'Vocabulary storage failed.'],
            ['timeout', 'Vocabulary request timed out.'],
            ['worker', 'Vocabulary worker failed.']
        ] as const;
        for (const [code, expectedMessage] of cases) {
            const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
            const ipcMain: IpcMainLike = {
                handle: (channel, listener) => handlers.set(channel, listener),
                removeHandler: (channel) => void handlers.delete(channel)
            };
            const memory: VocabularyRepositoryFacade = {
                queryHeat: async () => [],
                listEntries: async () => {
                    throw new MemoryDatabaseError(
                        code,
                        `Secret path C:\\temp\\api-key-${code}`
                    );
                },
                getMemoryEnabled: async () => true,
                updateEntry: async () => undefined,
                deleteEntries: async () => undefined,
                exportEntries: async () => '',
                setMemoryEnabled: async () => undefined
            };
            const unregister = registerIpcRouter({
                ipcMain,
                secureConfig: {
                    saveProvider: async () => {
                        throw new Error('not used');
                    },
                    setActiveProvider: async () => undefined,
                    getProviderSummaries: async () => [],
                    testProvider: async () => {
                        throw new Error('not used');
                    }
                },
                memory,
                isSenderAuthorized: () => true
            });
            const api = createVocabularyApi(async (channel, payload) => {
                const handler = handlers.get(channel);
                if (handler === undefined)
                    throw new Error(`Missing IPC handler: ${channel}`);
                return handler({}, payload);
            });
            await expect(api.listEntries()).rejects.toMatchObject({
                name: 'IpcClientError',
                code,
                message: expectedMessage
            });
            unregister();
        }

        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const ipcMain: IpcMainLike = {
            handle: (channel, listener) => handlers.set(channel, listener),
            removeHandler: (channel) => void handlers.delete(channel)
        };
        const memory: VocabularyRepositoryFacade = {
            queryHeat: async () => [],
            listEntries: async () => [],
            getMemoryEnabled: async () => true,
            updateEntry: async () => undefined,
            deleteEntries: async () => undefined,
            exportEntries: async () => {
                throw new MemoryDatabaseError(
                    'export-too-large',
                    `Secret oversized export ${'x'.repeat(100)}`
                );
            },
            setMemoryEnabled: async () => undefined
        };
        const unregister = registerIpcRouter({
            ipcMain,
            secureConfig: {
                saveProvider: async () => {
                    throw new Error('not used');
                },
                setActiveProvider: async () => undefined,
                getProviderSummaries: async () => [],
                testProvider: async () => {
                    throw new Error('not used');
                }
            },
            memory,
            isSenderAuthorized: () => true
        });
        const api = createVocabularyApi(async (channel, payload) => {
            const handler = handlers.get(channel);
            if (handler === undefined)
                throw new Error(`Missing IPC handler: ${channel}`);
            return handler({}, payload);
        });
        await expect(api.exportEntries('json')).rejects.toMatchObject({
            name: 'VocabularyExportSizeError',
            code: 'export-too-large',
            maximum: MAX_VOCABULARY_EXPORT_CHARS
        });
        expect(new VocabularyExportSizeError(MAX_VOCABULARY_EXPORT_CHARS).message)
            .toBe('Vocabulary export exceeds the 2,000,000 character limit.');
        unregister();
    });
});
