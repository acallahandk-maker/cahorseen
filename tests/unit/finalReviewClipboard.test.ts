import { describe, expect, it } from 'vitest';
import {
    SelectionService,
    type SelectionCaptureAdapter
} from '../../src/main/services/selectionService';
import type { ProviderConfig } from '../../src/shared/contracts';

const provider: ProviderConfig = {
    id: 'synthetic-provider',
    name: 'Synthetic Provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'placeholder-safe-credential',
    textModel: 'synthetic-text-model',
    visionModel: 'synthetic-vision-model',
    targetLanguage: 'fr-FR'
};

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function statefulClipboard(): {
    contents: { value: string };
    restoreCalls: number;
    adapter: SelectionCaptureAdapter;
} {
    const contents = { value: 'original' };
    const state = {
        contents,
        restoreCalls: 0,
        adapter: {
            readAccessibilitySelection: async () => '',
            copySelectionToClipboard: async () => {
                await delay(20);
                contents.value = 'selected';
            },
            readClipboardText: async () => contents.value,
            saveClipboard: async () => contents.value,
            restoreClipboard: async (snapshot: unknown) => {
                state.restoreCalls += 1;
                contents.value = String(snapshot);
            }
        } satisfies SelectionCaptureAdapter
    };
    return state;
}

function service(adapter: SelectionCaptureAdapter): SelectionService {
    return new SelectionService({
        captureAdapter: adapter,
        translationRunner: {
            run: async () => ({
                translatedText: 'Traduit',
                model: 'synthetic-text-model'
            })
        },
        getProvider: async () => provider
    });
}

describe('clipboard fallback restoration', () => {
    it('waits for delayed clipboard writes and restores once on success', async () => {
        const clipboard = statefulClipboard();

        const capture = await service(clipboard.adapter).captureSelectionOnce();

        expect(capture.sourceText).toBe('selected');
        expect(clipboard.restoreCalls).toBe(1);
        expect(clipboard.contents.value).toBe('original');
    });

    it('restores the actual clipboard after a delayed copy failure', async () => {
        const clipboard = statefulClipboard();
        clipboard.adapter.copySelectionToClipboard = async () => {
            await delay(20);
            clipboard.contents.value = 'failed-selection';
            throw new Error('copy failed');
        };

        await expect(service(clipboard.adapter).captureSelectionOnce()).rejects.toMatchObject({
            code: 'clipboard-read'
        });
        expect(clipboard.restoreCalls).toBe(1);
        expect(clipboard.contents.value).toBe('original');
    });

    it('cancels only after pending clipboard effects settle and propagates final restore failure', async () => {
        const clipboard = statefulClipboard();
        clipboard.adapter.restoreClipboard = async (snapshot: unknown) => {
            clipboard.restoreCalls += 1;
            clipboard.contents.value = String(snapshot);
            throw new Error('restore failed');
        };
        const controller = new AbortController();

        const capturePromise = service(clipboard.adapter).captureSelectionOnce(
            controller.signal
        );
        controller.abort();

        await expect(capturePromise).rejects.toMatchObject({
            code: 'clipboard-restore'
        });
        expect(clipboard.restoreCalls).toBe(1);
        expect(clipboard.contents.value).toBe('original');
    });
});
