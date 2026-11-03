import { describe, expect, it, vi } from 'vitest';
import {
    createVocabularyApi,
    VocabularyExportSizeError,
    type VocabularyIpcInvoke
} from '../../src/preload/vocabularyAdapter';
import {
    MAX_VOCABULARY_EXPORT_CHARS,
    memoryIpcChannels,
    type MemoryEntry,
    type MemoryEntryPatch,
    type MemoryFilter,
    type MemoryEntryQuery
} from '../../src/shared/contracts';

function makeEntry(): MemoryEntry {
    return {
        id: 'entry-1',
        sourceText: 'Hello',
        normalizedSource: 'hello',
        translatedText: '你好',
        sourceLanguage: 'en-US',
        targetLanguage: 'zh-CN',
        occurrenceCount: 2,
        recentOccurrenceCount: 1,
        translationCount: 2,
        firstSeenAt: '2026-10-01T12:00:00.000Z',
        lastUsedAt: '2026-10-29T12:00:00.000Z',
        context: 'At the counter',
        quizIntervalDays: 3,
        nextDueAt: '2026-11-01T12:00:00.000Z'
    };
}

function success(value: unknown): unknown {
    return { ok: true, value };
}

describe('vocabulary preload adapter', () => {
    it('forwards repository queries and mutations through the production IPC channels', async () => {
        const invoke = vi.fn(async (channel: string) => {
            if (channel === memoryIpcChannels.queryHeat)
                return success([]);
            if (channel === memoryIpcChannels.listEntries)
                return success([makeEntry()]);
            return { ok: true };
        });
        const api = createVocabularyApi(invoke);
        const filter: MemoryFilter = {
            sourceLanguage: 'en-US',
            targetLanguage: 'zh-CN',
            from: '2026-10-01T00:00:00.000Z'
        };
        const query: MemoryEntryQuery = {
            ...filter,
            search: 'hello',
            limit: 50
        };
        const patch: MemoryEntryPatch = {
            sourceText: 'Hello again',
            translatedText: '你好呀',
            sourceLanguage: 'en-US',
            targetLanguage: 'zh-CN',
            context: 'At the counter',
            quizIntervalDays: 7,
            nextDueAt: '2026-11-08T12:00:00.000Z'
        };

        await api.queryHeat(filter);
        await api.listEntries(query);
        await api.updateEntry('entry-1', patch);
        await api.deleteEntries(['entry-1']);
        await api.setMemoryEnabled(false);

        expect(invoke.mock.calls).toEqual([
            [memoryIpcChannels.queryHeat, filter],
            [memoryIpcChannels.listEntries, query],
            [memoryIpcChannels.updateEntry, { id: 'entry-1', patch }],
            [memoryIpcChannels.deleteEntries, { ids: ['entry-1'] }],
            [memoryIpcChannels.setMemoryEnabled, { enabled: false }]
        ]);
    });

    it('returns repository JSON and CSV export bytes unchanged', async () => {
        const entry = makeEntry();
        const json = JSON.stringify({
            version: 1,
            exportedAt: '2026-10-29T12:00:00.000Z',
            entries: [entry]
        }, null, 2);
        const csv = [
            'id,sourceText,normalizedSource,translatedText,sourceLanguage,targetLanguage,occurrenceCount,recentOccurrenceCount,translationCount,firstSeenAt,lastUsedAt,context,quizIntervalDays,nextDueAt',
            '"entry-1","Hello","hello","你好","en-US","zh-CN",2,1,2,"2026-10-01T12:00:00.000Z","2026-10-29T12:00:00.000Z","At the counter",3,"2026-11-01T12:00:00.000Z"',
            ''
        ].join('\n');
        let requestedFormat = 'csv';
        const invoke = vi.fn<VocabularyIpcInvoke>(async () => success(
            requestedFormat === 'json' ? json : csv
        ));
        const api = createVocabularyApi(invoke);

        requestedFormat = 'json';
        await expect(api.exportEntries('json')).resolves.toBe(json);
        requestedFormat = 'csv';
        await expect(api.exportEntries('csv')).resolves.toBe(csv);
    });

    it('rejects oversized repository exports with a typed size error', async () => {
        const api = createVocabularyApi(async () => success(
            'x'.repeat(MAX_VOCABULARY_EXPORT_CHARS + 1)
        ));

        await expect(api.exportEntries('json')).rejects.toMatchObject({
            name: 'VocabularyExportSizeError',
            code: 'export-too-large',
            maximum: MAX_VOCABULARY_EXPORT_CHARS
        });
        expect(new VocabularyExportSizeError(MAX_VOCABULARY_EXPORT_CHARS)).toBeInstanceOf(Error);
    });

    it('maps bounded IPC export failures to the typed size error', async () => {
        const api = createVocabularyApi(async () => ({
            ok: false,
            error: {
                code: 'export-too-large',
                message: 'Vocabulary export is too large.'
            }
        }));

        await expect(api.exportEntries('csv')).rejects.toMatchObject({
            name: 'VocabularyExportSizeError',
            code: 'export-too-large',
            maximum: MAX_VOCABULARY_EXPORT_CHARS
        });
    });

    it('preserves IPC failure codes at the production boundary', async () => {
        const api = createVocabularyApi(async () => ({
            ok: false,
            error: { code: 'storage', message: 'Storage failed.' }
        }));

        await expect(api.listEntries()).rejects.toMatchObject({
            name: 'IpcClientError',
            code: 'storage',
            message: 'Storage failed.'
        });
    });
});
