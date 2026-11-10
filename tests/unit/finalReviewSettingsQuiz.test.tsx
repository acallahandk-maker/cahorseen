// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsWindow from '../../src/renderer/settings/SettingsWindow';
import type { SettingsPreferences } from '../../src/shared/contracts';

const preferences = {
    hotkey: 'Ctrl+Shift+T',
    screenshotHotkey: 'Ctrl+Shift+S',
    privacy: {
        saveTranslationHistory: true
    },
    performance: {
        reduceMotion: false,
        pauseWhenFullscreen: true
    },
    quiz: {
        paused: false,
        frequencyWeights: {
            occurrenceCount: 25,
            recentOccurrenceCount: 75
        }
    }
} as unknown as SettingsPreferences;

afterEach(cleanup);

describe('final review settings controls', () => {
    it('shows truthful privacy and performance status without inert controls', () => {
        render(
            <SettingsWindow
                providers={[]}
                activeProviderId=""
                preferences={preferences}
            />
        );

        expect(screen.queryByLabelText('Restore clipboard')).toBeNull();
        expect(screen.queryByLabelText('Local-only processing')).toBeNull();
        expect(screen.queryByLabelText('Limit frame rate')).toBeNull();
        expect(screen.getByText(/source text is sent to the configured remote provider/i)).toBeDefined();
        expect(screen.getByText(/power-aware frame-rate limiting is always enabled/i)).toBeDefined();
    });

    it('round-trips custom quiz frequency weights through preference saving', () => {
        const onSavePreferences = vi.fn(async () => undefined);
        render(
            <SettingsWindow
                providers={[]}
                activeProviderId=""
                preferences={preferences}
                onSavePreferences={onSavePreferences}
            />
        );

        fireEvent.change(screen.getByLabelText('Total occurrence weight'), {
            target: { value: '40' }
        });
        fireEvent.change(screen.getByLabelText('Recent occurrence weight'), {
            target: { value: '60' }
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

        expect(onSavePreferences).toHaveBeenCalledWith(expect.objectContaining({
            privacy: {
                saveTranslationHistory: true
            },
            quiz: {
                paused: false,
                frequencyWeights: {
                    occurrenceCount: 40,
                    recentOccurrenceCount: 60
                }
            }
        }));
    });
});
