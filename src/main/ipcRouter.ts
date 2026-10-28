import { z } from 'zod';
import {
    connectionTestResultSchema,
    providerConfigSchema,
    providerSummarySchema,
    type ConnectionTestResult,
    type ProviderConfig,
    type ProviderSummary
} from '../shared/contracts';
import { validateProviderConfig } from './services/openAiClient';

export const providerIpcChannels = {
    save: 'desktop-pet:provider-save',
    summaries: 'desktop-pet:provider-summaries',
    test: 'desktop-pet:provider-test'
} as const;

export interface ProviderIpcService {
    saveProvider(config: ProviderConfig): Promise<void>;
    getProviderSummaries(): Promise<ProviderSummary[]>;
    testProvider(capability: 'text' | 'vision'): Promise<ConnectionTestResult>;
}

export interface IpcMainLike {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void;
    removeHandler(channel: string): void;
}

export interface RegisterIpcRouterOptions {
    ipcMain: IpcMainLike;
    secureConfig: ProviderIpcService;
    isSenderAuthorized?: (event: unknown) => boolean;
}

type ProviderIpcFailure = {
    ok: false;
    error: {
        code: 'unauthorized' | 'invalid-request' | 'request-failed';
        message: string;
    };
};

type ProviderIpcSuccess<T> = {
    ok: true;
    value: T;
};

type ProviderIpcSaveSuccess = {
    ok: true;
};

const testPayloadSchema = z.strictObject({
    capability: z.enum(['text', 'vision'])
});

function defaultIsSenderAuthorized(event: unknown): boolean {
    const senderFrame = (event as { senderFrame?: { url?: unknown } }).senderFrame;
    if (typeof senderFrame?.url !== 'string')
        return false;

    try {
        const url = new URL(senderFrame.url);
        return url.protocol === 'file:'
            || url.protocol === 'app:'
            || (
                ['http:', 'https:'].includes(url.protocol)
                && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            );
    } catch {
        return false;
    }
}

function failure(
    code: ProviderIpcFailure['error']['code'],
    message: string
): ProviderIpcFailure {
    return {
        ok: false,
        error: {
            code,
            message
        }
    };
}

function safeFailure(error: unknown): ProviderIpcFailure {
    if (
        error instanceof Error
        && ['SecureConfigError', 'ProviderError'].includes(error.name)
    )
        return failure('invalid-request', error.message);
    return failure('request-failed', 'Provider request failed.');
}

export function registerIpcRouter(options: RegisterIpcRouterOptions): () => void {
    const { ipcMain, secureConfig } = options;
    const isSenderAuthorized = options.isSenderAuthorized ?? defaultIsSenderAuthorized;

    ipcMain.handle(providerIpcChannels.save, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = providerConfigSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider configuration is invalid.');

        try {
            await secureConfig.saveProvider(validateProviderConfig(parsed.data));
            return { ok: true } satisfies ProviderIpcSaveSuccess;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(providerIpcChannels.summaries, async (event) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        try {
            const summaries = await secureConfig.getProviderSummaries();
            return {
                ok: true,
                value: summaries.map((summary) => providerSummarySchema.parse(summary))
            } satisfies ProviderIpcSuccess<ProviderSummary[]>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(providerIpcChannels.test, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = testPayloadSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-request', 'Provider test request is invalid.');

        try {
            const result = await secureConfig.testProvider(parsed.data.capability);
            return {
                ok: true,
                value: connectionTestResultSchema.parse(result)
            } satisfies ProviderIpcSuccess<ConnectionTestResult>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    return () => {
        ipcMain.removeHandler(providerIpcChannels.save);
        ipcMain.removeHandler(providerIpcChannels.summaries);
        ipcMain.removeHandler(providerIpcChannels.test);
    };
}
