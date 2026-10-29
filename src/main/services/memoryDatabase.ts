import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { z } from 'zod';
import {
    MAX_CONTEXT_CHARS,
    MAX_SOURCE_TEXT_CHARS,
    MAX_TARGET_LANGUAGE_CHARS,
    MAX_TRANSLATED_TEXT_CHARS,
    heatStatisticSchema,
    memoryEntrySchema,
    translationTaskSchema,
    type HeatStatistic,
    type MemoryEntry,
    type TranslationTask
} from '../../shared/contracts';

const timestampSchema = z.string().datetime({ offset: true });
const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();

export const memoryFilterSchema = z.strictObject({
    sourceLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    targetLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    from: timestampSchema.optional(),
    to: timestampSchema.optional()
}).refine((filter) => filter.from === undefined || filter.to === undefined
    || new Date(filter.from).getTime() <= new Date(filter.to).getTime(), {
    message: 'from must not be after to',
    path: ['from']
});

export const memoryEntryQuerySchema = memoryFilterSchema.extend({
    search: z.string().max(MAX_SOURCE_TEXT_CHARS).optional(),
    limit: z.number().int().min(1).max(10_000).optional()
});

export const memoryEntryPatchSchema = z.strictObject({
    sourceText: z.string().min(1).max(MAX_SOURCE_TEXT_CHARS).optional(),
    translatedText: z.string().max(MAX_TRANSLATED_TEXT_CHARS).optional(),
    sourceLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    targetLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    context: z.string().max(MAX_CONTEXT_CHARS).optional(),
    quizIntervalDays: positiveInteger.optional(),
    nextDueAt: timestampSchema.optional()
}).refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be supplied'
});

export type MemoryFilter = z.infer<typeof memoryFilterSchema>;
export type MemoryEntryQuery = z.infer<typeof memoryEntryQuerySchema>;
export type MemoryEntryPatch = z.infer<typeof memoryEntryPatchSchema>;

const memoryErrorSchema = z.strictObject({
    code: z.enum(['invalid-request', 'conflict', 'not-found', 'storage', 'internal']),
    message: z.string().max(500)
});

export type MemoryErrorCode = z.infer<typeof memoryErrorSchema>['code'];

export class MemoryDatabaseError extends Error {
    readonly code: MemoryErrorCode;

    constructor(code: MemoryErrorCode, message: string) {
        super(message);
        this.name = 'MemoryDatabaseError';
        this.code = code;
    }
}

const recordInputSchema = z.strictObject({
    task: translationTaskSchema,
    recordedAt: timestampSchema
});

export const memoryWorkerRequestSchema = z.discriminatedUnion('operation', [
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('recordTranslations'),
        records: z.array(recordInputSchema).min(1).max(256)
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('queryHeat'),
        filter: memoryFilterSchema,
        now: timestampSchema
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('listEntries'),
        query: memoryEntryQuerySchema,
        now: timestampSchema
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('updateEntry'),
        id: nonEmptyString,
        patch: memoryEntryPatchSchema
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('deleteEntries'),
        ids: z.array(nonEmptyString).min(1).max(500)
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('exportEntries'),
        format: z.enum(['json', 'csv']),
        now: timestampSchema
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('setMemoryEnabled'),
        enabled: z.boolean()
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('close')
    })
]);

export type MemoryWorkerRequest = z.infer<typeof memoryWorkerRequestSchema>;

export const memoryWorkerResponseSchema = z.union([
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('recordTranslations'),
        result: z.strictObject({ recorded: z.number().int().nonnegative() })
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('queryHeat'),
        result: z.strictObject({ statistics: z.array(heatStatisticSchema) })
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('listEntries'),
        result: z.strictObject({ entries: z.array(memoryEntrySchema) })
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('updateEntry'),
        result: z.strictObject({ updated: z.boolean() })
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('deleteEntries'),
        result: z.strictObject({ deleted: z.number().int().nonnegative() })
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('exportEntries'),
        result: z.strictObject({ value: z.string() })
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('setMemoryEnabled'),
        result: z.strictObject({ enabled: z.boolean() })
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(true),
        operation: z.literal('close'),
        result: z.null()
    }),
    z.strictObject({
        requestId: nonEmptyString,
        ok: z.literal(false),
        error: memoryErrorSchema
    })
]);

type WorkerResponse = z.infer<typeof memoryWorkerResponseSchema>;
type WorkerSuccessResponse = Extract<WorkerResponse, { ok: true }>;

export interface MemoryDatabaseOptions {
    databasePath: string;
    workerPath: string;
    workerFactory?: (filename: string, options: WorkerOptions) => Worker;
    now?: () => Date;
    requestTimeoutMs?: number;
}

interface PendingRequest {
    resolve: (response: WorkerSuccessResponse) => void;
    reject: (error: MemoryDatabaseError) => void;
    timer: NodeJS.Timeout;
    operation: MemoryWorkerRequest['operation'];
}

interface PendingRecord {
    task: TranslationTask;
    recordedAt: string;
    resolve: () => void;
    reject: (error: MemoryDatabaseError) => void;
}

function toIso(value: Date): string {
    if (Number.isNaN(value.getTime()))
        throw new MemoryDatabaseError('invalid-request', 'The clock returned an invalid date.');
    return value.toISOString();
}

function parseResponse(value: unknown): WorkerResponse {
    const parsed = memoryWorkerResponseSchema.safeParse(value);
    if (!parsed.success)
        throw new MemoryDatabaseError('internal', 'The memory worker returned an invalid response.');
    return parsed.data;
}

export class MemoryDatabase {
    private readonly databasePath: string;
    private readonly workerPath: string;
    private readonly workerFactory: (filename: string, options: WorkerOptions) => Worker;
    private readonly now: () => Date;
    private readonly requestTimeoutMs: number;
    private worker: Worker | undefined;
    private readonly pending = new Map<string, PendingRequest>();
    private recordQueue: PendingRecord[] = [];
    private recordFlushScheduled = false;
    private closed = false;

    constructor(options: MemoryDatabaseOptions) {
        this.databasePath = options.databasePath;
        this.workerPath = options.workerPath;
        this.workerFactory = options.workerFactory ?? ((filename, workerOptions) => new Worker(
            filename,
            workerOptions
        ));
        this.now = options.now ?? (() => new Date());
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    }

    async recordTranslation(task: TranslationTask): Promise<void> {
        const parsed = translationTaskSchema.safeParse(task);
        if (!parsed.success || parsed.data.status !== 'completed')
            throw new MemoryDatabaseError('invalid-request', 'Only completed translation tasks can be recorded.');
        return new Promise<void>((resolve, reject) => {
            this.recordQueue.push({
                task: parsed.data,
                recordedAt: toIso(this.now()),
                resolve,
                reject
            });
            this.scheduleRecordFlush();
        });
    }

    async queryHeat(filter: MemoryFilter = {}): Promise<HeatStatistic[]> {
        const request: MemoryWorkerRequest = {
            requestId: randomUUID(),
            operation: 'queryHeat',
            filter: memoryFilterSchema.parse(filter),
            now: toIso(this.now())
        };
        const response = await this.send(request);
        if (response.operation !== 'queryHeat')
            throw new MemoryDatabaseError('internal', 'The memory worker returned the wrong result.');
        return response.result.statistics;
    }

    async listEntries(query: MemoryEntryQuery = {}): Promise<MemoryEntry[]> {
        const request: MemoryWorkerRequest = {
            requestId: randomUUID(),
            operation: 'listEntries',
            query: memoryEntryQuerySchema.parse(query),
            now: toIso(this.now())
        };
        const response = await this.send(request);
        if (response.operation !== 'listEntries')
            throw new MemoryDatabaseError('internal', 'The memory worker returned the wrong result.');
        return response.result.entries;
    }

    async updateEntry(id: string, patch: MemoryEntryPatch): Promise<void> {
        const request: MemoryWorkerRequest = {
            requestId: randomUUID(),
            operation: 'updateEntry',
            id: nonEmptyString.parse(id),
            patch: memoryEntryPatchSchema.parse(patch)
        };
        const response = await this.send(request);
        if (response.operation !== 'updateEntry' || !response.result.updated)
            throw new MemoryDatabaseError('not-found', 'The vocabulary entry was not found.');
    }

    async deleteEntries(ids: string[]): Promise<void> {
        const request: MemoryWorkerRequest = {
            requestId: randomUUID(),
            operation: 'deleteEntries',
            ids: z.array(nonEmptyString).min(1).max(500).parse(ids)
        };
        const response = await this.send(request);
        if (response.operation !== 'deleteEntries')
            throw new MemoryDatabaseError('internal', 'The memory worker returned the wrong result.');
    }

    async exportEntries(format: 'json' | 'csv'): Promise<string> {
        const request: MemoryWorkerRequest = {
            requestId: randomUUID(),
            operation: 'exportEntries',
            format: z.enum(['json', 'csv']).parse(format),
            now: toIso(this.now())
        };
        const response = await this.send(request);
        if (response.operation !== 'exportEntries')
            throw new MemoryDatabaseError('internal', 'The memory worker returned the wrong result.');
        return response.result.value;
    }

    async setMemoryEnabled(enabled: boolean): Promise<void> {
        const request: MemoryWorkerRequest = {
            requestId: randomUUID(),
            operation: 'setMemoryEnabled',
            enabled: z.boolean().parse(enabled)
        };
        const response = await this.send(request);
        if (response.operation !== 'setMemoryEnabled')
            throw new MemoryDatabaseError('internal', 'The memory worker returned the wrong result.');
    }

    async close(): Promise<void> {
        if (this.closed)
            return;
        await this.flushRecords();
        this.closed = true;
        const worker = this.worker;
        if (worker === undefined)
            return;
        try {
            await this.send({ requestId: randomUUID(), operation: 'close' });
        } finally {
            this.worker = undefined;
            await worker.terminate();
        }
    }

    private scheduleRecordFlush(): void {
        if (this.recordFlushScheduled)
            return;
        this.recordFlushScheduled = true;
        queueMicrotask(() => {
            this.recordFlushScheduled = false;
            void this.flushRecords();
        });
    }

    private async flushRecords(): Promise<void> {
        while (this.recordQueue.length > 0) {
            const records = this.recordQueue.splice(0, 256);
            try {
                const response = await this.send({
                    requestId: randomUUID(),
                    operation: 'recordTranslations',
                    records: records.map((record) => ({
                        task: record.task,
                        recordedAt: record.recordedAt
                    }))
                });
                if (response.operation !== 'recordTranslations')
                    throw new MemoryDatabaseError('internal', 'The memory worker returned the wrong result.');
                for (const record of records)
                    record.resolve();
            } catch (error) {
                const memoryError = error instanceof MemoryDatabaseError
                    ? error
                    : new MemoryDatabaseError('internal', 'The memory worker failed.');
                for (const record of records)
                    record.reject(memoryError);
            }
        }
    }

    private ensureWorker(): Worker {
        if (this.worker !== undefined)
            return this.worker;
        if (this.closed)
            throw new MemoryDatabaseError('internal', 'The memory database is closed.');
        const worker = this.workerFactory(this.workerPath, {
            workerData: { databasePath: this.databasePath }
        });
        worker.on('message', (raw: unknown) => {
            let response: WorkerResponse;
            try {
                response = parseResponse(raw);
            } catch (error) {
                for (const pending of this.pending.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(error as MemoryDatabaseError);
                }
                this.pending.clear();
                return;
            }
            const pending = this.pending.get(response.requestId);
            if (pending === undefined)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(response.requestId);
            if (response.ok)
                pending.resolve(response);
            else
                pending.reject(new MemoryDatabaseError(response.error.code, response.error.message));
        });
        worker.once('error', () => {
            this.rejectAll(new MemoryDatabaseError('internal', 'The memory worker failed.'));
        });
        worker.once('exit', () => {
            this.worker = undefined;
            this.rejectAll(new MemoryDatabaseError('internal', 'The memory worker stopped unexpectedly.'));
        });
        this.worker = worker;
        return worker;
    }

    private rejectAll(error: MemoryDatabaseError): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        for (const record of this.recordQueue.splice(0))
            record.reject(error);
    }

    private send(request: MemoryWorkerRequest): Promise<WorkerSuccessResponse> {
        const worker = this.ensureWorker();
        return new Promise<WorkerSuccessResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request.requestId);
                reject(new MemoryDatabaseError('internal', 'The memory worker timed out.'));
            }, this.requestTimeoutMs);
            this.pending.set(request.requestId, {
                resolve,
                reject,
                timer,
                operation: request.operation
            });
            worker.postMessage(request);
        });
    }
}

export async function createDefaultMemoryDatabase(
    options: Omit<MemoryDatabaseOptions, 'databasePath' | 'workerPath'> & {
        databasePath?: string;
        workerPath?: string;
    } = {}
): Promise<MemoryDatabase> {
    const { app } = await import('electron');
    return new MemoryDatabase({
        ...options,
        databasePath: options.databasePath ?? join(app.getPath('userData'), 'vocabulary-memory.sqlite3'),
        workerPath: options.workerPath ?? join(__dirname, 'memoryWorker.js')
    });
}

let defaultDatabase: Promise<MemoryDatabase> | undefined;

function getDefaultDatabase(): Promise<MemoryDatabase> {
    defaultDatabase ??= createDefaultMemoryDatabase();
    return defaultDatabase;
}

export async function recordTranslation(task: TranslationTask): Promise<void> {
    await (await getDefaultDatabase()).recordTranslation(task);
}

export async function queryHeat(filter?: MemoryFilter): Promise<HeatStatistic[]> {
    return (await getDefaultDatabase()).queryHeat(filter);
}

export async function listEntries(query?: MemoryEntryQuery): Promise<MemoryEntry[]> {
    return (await getDefaultDatabase()).listEntries(query);
}

export async function updateEntry(id: string, patch: MemoryEntryPatch): Promise<void> {
    await (await getDefaultDatabase()).updateEntry(id, patch);
}

export async function deleteEntries(ids: string[]): Promise<void> {
    await (await getDefaultDatabase()).deleteEntries(ids);
}

export async function exportEntries(format: 'json' | 'csv'): Promise<string> {
    return (await getDefaultDatabase()).exportEntries(format);
}

export async function setMemoryEnabled(enabled: boolean): Promise<void> {
    await (await getDefaultDatabase()).setMemoryEnabled(enabled);
}
