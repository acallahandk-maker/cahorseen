import { z } from 'zod';
import { IpcClientError, parseIpcAck, parseIpcResult } from './ipcResult';
import {
    MAX_VOCABULARY_EXPORT_CHARS,
    heatStatisticSchema,
    memoryEntryPatchSchema,
    memoryEntryQuerySchema,
    memoryEntrySchema,
    memoryExportFormatSchema,
    memoryFilterSchema,
    memoryIpcChannels,
    type MemoryEntryPatch,
    type MemoryEntryQuery,
    type MemoryExportFormat,
    type MemoryFilter,
    type VocabularyRepositoryFacade
} from '../shared/contracts';

export type VocabularyIpcInvoke = (
    channel: string,
    payload: unknown
) => Promise<unknown>;

export class VocabularyExportSizeError extends Error {
    readonly code = 'export-too-large';
    readonly maximum: number;

    constructor(maximum: number) {
        super(`Vocabulary export exceeds the ${maximum.toLocaleString()} character limit.`);
        this.name = 'VocabularyExportSizeError';
        this.maximum = maximum;
    }
}

const updatePayloadSchema = z.strictObject({
    id: z.string().min(1),
    patch: memoryEntryPatchSchema
});

const deletePayloadSchema = z.strictObject({
    ids: z.array(z.string().min(1)).min(1).max(500)
});

const exportPayloadSchema = z.strictObject({
    format: memoryExportFormatSchema
});

const setEnabledPayloadSchema = z.strictObject({
    enabled: z.boolean()
});

export function createVocabularyApi(
    invoke: VocabularyIpcInvoke
): VocabularyRepositoryFacade {
    return {
        queryHeat: async (filter: MemoryFilter = {}) => parseIpcResult(
            z.array(heatStatisticSchema),
            await invoke(
                memoryIpcChannels.queryHeat,
                memoryFilterSchema.parse(filter)
            )
        ),
        listEntries: async (query: MemoryEntryQuery = {}) => parseIpcResult(
            z.array(memoryEntrySchema),
            await invoke(
                memoryIpcChannels.listEntries,
                memoryEntryQuerySchema.parse(query)
            )
        ),
        updateEntry: async (id: string, patch: MemoryEntryPatch) => {
            const request = updatePayloadSchema.parse({ id, patch });
            parseIpcAck(await invoke(memoryIpcChannels.updateEntry, request));
        },
        deleteEntries: async (ids: string[]) => {
            const request = deletePayloadSchema.parse({ ids });
            parseIpcAck(await invoke(memoryIpcChannels.deleteEntries, request));
        },
        exportEntries: async (format: MemoryExportFormat) => {
            const request = exportPayloadSchema.parse({ format });
            let value: string;
            try {
                value = parseIpcResult(
                    z.string(),
                    await invoke(memoryIpcChannels.exportEntries, request)
                );
            } catch (error) {
                if ((error as { code?: unknown }).code === 'export-too-large')
                    throw new VocabularyExportSizeError(MAX_VOCABULARY_EXPORT_CHARS);
                throw error;
            }
            if (value.length > MAX_VOCABULARY_EXPORT_CHARS)
                throw new VocabularyExportSizeError(MAX_VOCABULARY_EXPORT_CHARS);
            return value;
        },
        setMemoryEnabled: async (enabled: boolean) => {
            const request = setEnabledPayloadSchema.parse({ enabled });
            parseIpcAck(await invoke(memoryIpcChannels.setMemoryEnabled, request));
        }
    };
}

export { IpcClientError };
