import { describe, expect, it, vi } from 'vitest';
import {
    registerIpcRouter
} from '../../src/main/ipcRouter';
import { SecureConfigError } from '../../src/main/services/secureConfig';
import { ProviderError } from '../../src/main/services/openAiClient';
import { settingsIpcChannels } from '../../src/shared/contracts';

function handlerMap() {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    return {
        handlers,
        ipcMain: {
            handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
                handlers.set(channel, handler);
            },
            removeHandler: (channel: string) => {
                handlers.delete(channel);
            }
        }
    };
}

function secureConfigWithFailure(error: unknown) {
    return {
        saveProvider: vi.fn(),
        setActiveProvider: vi.fn(),
        getProviderSummaries: vi.fn(),
        testProvider: vi.fn(),
        getSettings: vi.fn(async () => {
            throw error;
        })
    };
}

describe('final review IPC error classification', () => {
    it('does not trust attacker-controlled error names', async () => {
        const { handlers, ipcMain } = handlerMap();
        const error = Object.assign(new Error('secret should not escape'), {
            name: 'SecureConfigError',
            code: 'authentication'
        });
        registerIpcRouter({
            ipcMain,
            secureConfig: secureConfigWithFailure(error),
            isSenderAuthorized: () => true
        });

        const result = await handlers.get(settingsIpcChannels.get)?.({}, {});

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: 'request-failed'
            }
        });
        expect(JSON.stringify(result)).not.toContain('secret should not escape');
    });

    it('classifies concrete provider and secure-config errors by instance', async () => {
        const providerHandlers = handlerMap();
        registerIpcRouter({
            ipcMain: providerHandlers.ipcMain,
            secureConfig: secureConfigWithFailure(new ProviderError('authentication')),
            isSenderAuthorized: () => true
        });
        const providerResult = await providerHandlers.handlers.get(
            settingsIpcChannels.get
        )?.({}, {});
        expect(providerResult).toMatchObject({
            ok: false,
            error: { code: 'authentication' }
        });

        const configHandlers = handlerMap();
        registerIpcRouter({
            ipcMain: configHandlers.ipcMain,
            secureConfig: secureConfigWithFailure(
                new SecureConfigError('provider-not-found')
            ),
            isSenderAuthorized: () => true
        });
        const configResult = await configHandlers.handlers.get(
            settingsIpcChannels.get
        )?.({}, {});
        expect(configResult).toMatchObject({
            ok: false,
            error: { code: 'provider-not-found' }
        });
    });
});
