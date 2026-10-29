import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import SettingsWindow, {
    maskSecret,
    validateHotkey
} from '../../src/renderer/settings/SettingsWindow';
import type { ProviderSummary, SettingsPreferences } from '../../src/shared/contracts';

const providers: ProviderSummary[] = [{
    id: 'synthetic-provider',
    name: 'Synthetic Provider',
    baseUrl: 'https://provider.example/v1',
    hasApiKey: true,
    textModel: 'synthetic-text-model',
    visionModel: 'synthetic-vision-model'
}];

const preferences: SettingsPreferences = {
    hotkey: 'Ctrl+Shift+T',
    privacy: {
        localOnly: true,
        saveTranslationHistory: false,
        restoreClipboard: true
    },
    performance: {
        reduceMotion: false,
        pauseWhenFullscreen: true,
        limitFrameRate: true
    }
};

describe('SettingsWindow', () => {
    it('renders provider CRUD, separate model fields, and connection tests', () => {
        const markup = renderToStaticMarkup(
            <SettingsWindow
                providers={providers}
                activeProviderId="synthetic-provider"
                preferences={preferences}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn()}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        expect(markup).toContain('Add provider');
        expect(markup).toContain('Delete provider');
        expect(markup).toContain('Text model');
        expect(markup).toContain('Vision model');
        expect(markup).toContain('Test text connection');
        expect(markup).toContain('Test vision connection');
    });

    it('masks stored secrets and keeps replacement write-only', () => {
        expect(maskSecret('sk-synthetic-test-only-123')).toBe('••••••••');
        expect(maskSecret('')).toBe('Not set');

        const markup = renderToStaticMarkup(
            <SettingsWindow
                providers={providers}
                activeProviderId="synthetic-provider"
                preferences={preferences}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn()}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        expect(markup).toContain('Write-only replacement');
        expect(markup).not.toContain('sk-synthetic-test-only-123');
    });

    it('validates hotkey capture with modifiers and exactly one key', () => {
        expect(validateHotkey('Ctrl+Shift+T')).toEqual({
            valid: true,
            value: 'Ctrl+Shift+T'
        });
        expect(validateHotkey('Ctrl+K').valid).toBe(true);
        expect(validateHotkey('K')).toEqual({
            valid: false,
            error: 'Use one or more modifiers plus exactly one key.'
        });
        expect(validateHotkey('Ctrl+Shift')).toEqual({
            valid: false,
            error: 'Use one or more modifiers plus exactly one key.'
        });
        expect(validateHotkey('Ctrl+Ctrl+K')).toEqual({
            valid: false,
            error: 'Use one or more modifiers plus exactly one key.'
        });
    });

    it('renders privacy and performance preferences and recoverable errors', () => {
        const markup = renderToStaticMarkup(
            <SettingsWindow
                providers={providers}
                activeProviderId="synthetic-provider"
                preferences={preferences}
                error={{
                    code: 'invalid-config',
                    message: 'Provider configuration is invalid.'
                }}
                onSaveProvider={vi.fn()}
                onDeleteProvider={vi.fn()}
                onSelectProvider={vi.fn()}
                onTestProvider={vi.fn()}
                onSavePreferences={vi.fn()}
            />
        );

        expect(markup).toContain('Privacy');
        expect(markup).toContain('Performance');
        expect(markup).toContain('role="alert"');
        expect(markup).toContain('data-error-code="invalid-config"');
    });
});
