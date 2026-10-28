import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    connectionTestResultSchema,
    providerErrorCodeSchema,
    providerConfigSchema,
    providerSummarySchema,
    type ConnectionTestResult,
    type ProviderErrorCode,
    type ProviderConfig,
    type ProviderSummary
} from '../shared/contracts';
import { validateProviderConfig } from './services/openAiClient';

export const providerIpcChannels = {
    save: 'desktop-pet:provider-save',
    setActive: 'desktop-pet:provider-set-active',
    summaries: 'desktop-pet:provider-summaries',
    test: 'desktop-pet:provider-test'
} as const;

export interface ProviderIpcService {
    saveProvider(config: ProviderConfig): Promise<ProviderSummary>;
    setActiveProvider(providerId: string): Promise<void>;
    getProviderSummaries(): Promise<ProviderSummary[]>;
    testProvider(
        providerId: string,
        capability: 'text' | 'vision'
    ): Promise<ConnectionTestResult>;
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
        code: 'unauthorized' | 'invalid-request' | 'request-failed' | ProviderErrorCode;
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
    providerId: z.string().min(1),
    capability: z.enum(['text', 'vision'])
});

const setActivePayloadSchema = z.strictObject({
    providerId: z.string().min(1)
});

export function getProductionRendererFileUrl(): string {
    return pathToFileURL(join(__dirname, '../renderer/index.html')).href;
}

function defaultIsSenderAuthorized(event: unknown): boolean {
    const senderFrame = (event as { senderFrame?: { url?: unknown } }).senderFrame;
    if (typeof senderFrame?.url !== 'string')
        return false;

    return senderFrame.url === getProductionRendererFileUrl()
        || (
            process.env.ELECTRON_RENDERER_URL !== undefined
            && senderFrame.url === process.env.ELECTRON_RENDERER_URL
        );
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
    if (error instanceof Error) {
        const code = (error as Error & { code?: unknown }).code;
        if (providerErrorCodeSchema.safeParse(code).success)
            return failure(code as ProviderErrorCode, error.message);
        if (['SecureConfigError', 'ProviderError'].includes(error.name))
            return failure('invalid-config', error.message);
    }
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
            return failure('invalid-config', 'Provider configuration is invalid.');

        try {
            const summary = await secureConfig.saveProvider(
                validateProviderConfig(parsed.data)
            );
            return {
                ok: true,
                value: providerSummarySchema.parse(summary)
            } satisfies ProviderIpcSuccess<ProviderSummary>;
        } catch (error) {
            return safeFailure(error);
        }
    });

    ipcMain.handle(providerIpcChannels.setActive, async (event, payload) => {
        if (!isSenderAuthorized(event))
            return failure('unauthorized', 'IPC sender is not authorized.');

        const parsed = setActivePayloadSchema.safeParse(payload);
        if (!parsed.success)
            return failure('invalid-config', 'Provider selection is invalid.');

        try {
            await secureConfig.setActiveProvider(parsed.data.providerId);
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
            return failure('invalid-config', 'Provider test request is invalid.');

        try {
            const result = await secureConfig.testProvider(
                parsed.data.providerId,
                parsed.data.capability
            );
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
        ipcMain.removeHandler(providerIpcChannels.setActive);
        ipcMain.removeHandler(providerIpcChannels.summaries);
        ipcMain.removeHandler(providerIpcChannels.test);
    };
}
