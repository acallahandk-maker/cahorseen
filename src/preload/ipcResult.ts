import { z } from 'zod';

const ipcErrorSchema = z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1)
});

const ipcFailureSchema = z.strictObject({
    ok: z.literal(false),
    error: ipcErrorSchema
});

export class IpcClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'IpcClientError';
        this.code = code;
    }
}

function successSchema<T>(value: z.ZodType<T>): z.ZodType<{ ok: true; value: T }> {
    return z.strictObject({
        ok: z.literal(true),
        value
    });
}

export function parseIpcResult<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = z.union([successSchema(schema), ipcFailureSchema]).parse(raw);
    if (!parsed.ok)
        throw new IpcClientError(parsed.error.code, parsed.error.message);
    return parsed.value;
}

export function parseIpcTaskResult<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = z.union([
        successSchema(schema),
        z.strictObject({
            ok: z.literal(false),
            error: ipcErrorSchema,
            task: schema
        })
    ]).parse(raw);
    return parsed.ok ? parsed.value : parsed.task;
}

export function parseIpcAck(raw: unknown): void {
    const parsed = z.union([
        z.strictObject({ ok: z.literal(true) }),
        ipcFailureSchema
    ]).parse(raw);
    if (!parsed.ok)
        throw new IpcClientError(parsed.error.code, parsed.error.message);
}
