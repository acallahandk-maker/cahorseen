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
    memoryPersistenceStatusSchema,
    translationTaskSchema,
    type HeatStatistic,
    type MemoryEntry,
    type MemoryPersistenceStatus,
    type TranslationTask
} from '../../shared/contracts';

const timestampSchema = z.string().datetime({ offset: true });
const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();
const epochMilliseconds = z.number().int();

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
    code: z.enum([
        'busy',
        'conflict',
        'internal',
        'invalid-request',
        'not-found',
        'storage',
        'timeout',
        'worker'
    ]),
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

export function memoryFailureStatus(error: unknown): MemoryPersistenceStatus {
    const code = error instanceof MemoryDatabaseError ? error.code : 'internal';
    const message = error instanceof Error && error.message.length > 0
        ? error.message
        : 'Translation memory persistence failed.';
    return memoryPersistenceStatusSchema.parse({
        state: 'failed',
        code,
        recoverable: true,
        message: message.slice(0, 500)
    });
}

export function memoryRecordedStatus(): MemoryPersistenceStatus {
    return memoryPersistenceStatusSchema.parse({
        state: 'recorded',
        recoverable: true,
        message: 'Translation memory recorded.'
    });
}

const workerFilterSchema = z.strictObject({
    sourceLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    targetLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    fromMs: epochMilliseconds.optional(),
    toMs: epochMilliseconds.optional()
});

const workerEntryQuerySchema = workerFilterSchema.extend({
    search: z.string().max(MAX_SOURCE_TEXT_CHARS).optional(),
    limit: z.number().int().min(1).max(10_000).optional()
});

const workerEntryPatchSchema = z.strictObject({
    sourceText: z.string().min(1).max(MAX_SOURCE_TEXT_CHARS).optional(),
    translatedText: z.string().max(MAX_TRANSLATED_TEXT_CHARS).optional(),
    sourceLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    targetLanguage: z.string().min(1).max(MAX_TARGET_LANGUAGE_CHARS).optional(),
    context: z.string().max(MAX_CONTEXT_CHARS).optional(),
    quizIntervalDays: positiveInteger.optional(),
    nextDueAtMs: epochMilliseconds.optional()
});

const recordInputSchema = z.strictObject({
    task: translationTaskSchema,
    recordedAtMs: epochMilliseconds
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
        filter: workerFilterSchema,
        nowMs: epochMilliseconds
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('listEntries'),
        query: workerEntryQuerySchema,
        nowMs: epochMilliseconds
    }),
    z.strictObject({
        requestId: nonEmptyString,
        operation: z.literal('updateEntry'),
        id: nonEmptyString,
        patch: workerEntryPatchSchema
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
        nowMs: epochMilliseconds
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
    maxQueuedRecords?: number;
}

interface PendingRequest {
    resolve: (response: WorkerSuccessResponse) => void;
    reject: (error: MemoryDatabaseError) => void;
    timer: NodeJS.Timeout;
    operation: MemoryWorkerRequest['operation'];
}

interface PendingRecord {
    task: TranslationTask;
    recordedAtMs: number;
    resolve: () => void;
    reject: (error: MemoryDatabaseError) => void;
}

function toEpochMilliseconds(value: Date | string): number {
    const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(milliseconds))
        throw new MemoryDatabaseError('invalid-request', 'The clock returned an invalid date.');
    return milliseconds;
}

function toWorkerFilter(filter: MemoryFilter): z.infer<typeof workerFilterSchema> {
    return {
        ...(filter.sourceLanguage === undefined ? {} : { sourceLanguage: filter.sourceLanguage }),
        ...(filter.targetLanguage === undefined ? {} : { targetLanguage: filter.targetLanguage }),
        ...(filter.from === undefined ? {} : { fromMs: toEpochMilliseconds(filter.from) }),
        ...(filter.to === undefined ? {} : { toMs: toEpochMilliseconds(filter.to) })
    };
}

function toWorkerQuery(query: MemoryEntryQuery): z.infer<typeof workerEntryQuerySchema> {
    return {
        ...toWorkerFilter(query),
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.limit === undefined ? {} : { limit: query.limit })
    };
}

function toWorkerPatch(patch: MemoryEntryPatch): z.infer<typeof workerEntryPatchSchema> {
    const { nextDueAt, ...safePatch } = patch;
    return {
        ...safePatch,
        ...(nextDueAt === undefined ? {} : {
            nextDueAtMs: toEpochMilliseconds(nextDueAt)
        })
    };
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
    private readonly maxQueuedRecords: number;
    private worker: Worker | undefined;
    private readonly pending = new Map<string, PendingRequest>();
    private recordQueue: PendingRecord[] = [];
    private recordFlushScheduled = false;
    private closed = false;
    private closing = false;

    constructor(options: MemoryDatabaseOptions) {
        if (!Number.isInteger(options.requestTimeoutMs ?? 15_000)
            || (options.requestTimeoutMs ?? 15_000) < 1)
            throw new MemoryDatabaseError('invalid-request', 'Request timeout must be positive.');
        if (!Number.isInteger(options.maxQueuedRecords ?? 1_024)
            || (options.maxQueuedRecords ?? 1_024) < 1)
            throw new MemoryDatabaseError('invalid-request', 'Record queue limit must be positive.');
        this.databasePath = options.databasePath;
        this.workerPath = options.workerPath;
        this.workerFactory = options.workerFactory ?? ((filename, workerOptions) => new Worker(
            filename,
            workerOptions
        ));
        this.now = options.now ?? (() => new Date());
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
        this.maxQueuedRecords = options.maxQueuedRecords ?? 1_024;
    }

    async recordTranslation(task: TranslationTask): Promise<void> {
        const parsed = translationTaskSchema.safeParse(task);
        if (!parsed.success || parsed.data.status !== 'completed')
            throw new MemoryDatabaseError('invalid-request', 'Only completed translation tasks can be recorded.');
        if (this.recordQueue.length >= this.maxQueuedRecords)
            throw new MemoryDatabaseError('busy', 'The translation memory queue is saturated.');
        return new Promise<void>((resolve, reject) => {
            this.recordQueue.push({
                task: parsed.data,
                recordedAtMs: toEpochMilliseconds(this.now()),
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
            filter: toWorkerFilter(memoryFilterSchema.parse(filter)),
            nowMs: toEpochMilliseconds(this.now())
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
            query: toWorkerQuery(memoryEntryQuerySchema.parse(query)),
            nowMs: toEpochMilliseconds(this.now())
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
            patch: toWorkerPatch(memoryEntryPatchSchema.parse(patch))
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
            nowMs: toEpochMilliseconds(this.now())
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
        this.closing = true;
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
                        recordedAtMs: record.recordedAtMs
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
                this.recycleWorker(
                    worker,
                    error instanceof MemoryDatabaseError
                        ? error
                        : new MemoryDatabaseError('internal', 'The memory worker returned an invalid response.')
                );
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
            this.recycleWorker(worker, new MemoryDatabaseError('worker', 'The memory worker failed.'));
        });
        worker.once('exit', () => {
            if (this.worker === worker && !this.closing)
                this.recycleWorker(worker, new MemoryDatabaseError('worker', 'The memory worker stopped unexpectedly.'));
        });
        this.worker = worker;
        return worker;
    }

    private rejectPending(error: MemoryDatabaseError): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private recycleWorker(worker: Worker, error: MemoryDatabaseError): void {
        if (this.worker !== worker)
            return;
        this.worker = undefined;
        this.rejectPending(error);
        void worker.terminate();
    }

    private send(request: MemoryWorkerRequest): Promise<WorkerSuccessResponse> {
        const worker = this.ensureWorker();
        return new Promise<WorkerSuccessResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.recycleWorker(worker, new MemoryDatabaseError('timeout', 'The memory worker timed out.'));
            }, this.requestTimeoutMs);
            this.pending.set(request.requestId, {
                resolve,
                reject,
                timer,
                operation: request.operation
            });
            try {
                worker.postMessage(request);
            } catch {
                clearTimeout(timer);
                this.pending.delete(request.requestId);
                this.recycleWorker(worker, new MemoryDatabaseError('worker', 'The memory worker stopped unexpectedly.'));
                reject(new MemoryDatabaseError('worker', 'The memory worker stopped unexpectedly.'));
            }
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
