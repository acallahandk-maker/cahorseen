// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TranslationBubble, {
    copyTranslation,
    speakTranslation
} from '../../src/renderer/translation/TranslationBubble';
import {
    SelectionService,
    type SelectionCaptureAdapter,
    type TranslationRunner
} from '../../src/main/services/selectionService';
import type { ProviderConfig, TranslationTask } from '../../src/shared/contracts';

const completedTask: TranslationTask = {
    id: 'task-1',
    status: 'completed',
    sourceText: 'hello',
    translatedText: '你好',
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    providerId: 'synthetic-provider',
    providerName: 'Synthetic Provider',
    textModel: 'synthetic-text-model',
    visionModel: 'synthetic-vision-model',
    translationModel: 'synthetic-text-model'
};

afterEach(cleanup);

describe('TranslationBubble', () => {
    it('renders production source target provider and model details from the task', () => {
        render(<TranslationBubble task={completedTask} />);

        expect(screen.getByText(/en → zh-CN/).textContent).toContain('en → zh-CN');
        expect(screen.getByText(/Synthetic Provider/).textContent).toContain(
            'Synthetic Provider'
        );
        expect(screen.getByText(/synthetic-text-model/).textContent).toContain(
            'synthetic-text-model'
        );
        expect(screen.getByText(/synthetic-vision-model/).textContent).toContain(
            'synthetic-vision-model'
        );
    });

    it('renders details produced by the production selection translation path', async () => {
        const providerConfig: ProviderConfig = {
            id: 'production-provider',
            name: 'Production Provider',
            baseUrl: 'https://provider.example/v1',
            apiKey: 'sk-synthetic-test-only-123',
            textModel: 'production-text-model',
            visionModel: 'production-vision-model',
            targetLanguage: 'zh-CN'
        };
        const captureAdapter: SelectionCaptureAdapter = {
            readAccessibilitySelection: vi.fn(async () => 'hello'),
            copySelectionToClipboard: vi.fn(async () => undefined),
            readClipboardText: vi.fn(async () => ''),
            saveClipboard: vi.fn(async () => undefined),
            restoreClipboard: vi.fn(async () => undefined)
        };
        const translationRunner: TranslationRunner = {
            run: vi.fn(async () => ({
                translatedText: '你好',
                model: 'production-used-model'
            }))
        };
        const service = new SelectionService({
            captureAdapter,
            translationRunner,
            getProvider: async () => providerConfig,
            createId: () => 'production-task'
        });

        const task = await service.translateSelection();
        render(<TranslationBubble task={task} />);

        expect(screen.getByText(/en → zh-CN/).textContent).toContain('en → zh-CN');
        expect(screen.getByLabelText('Translation provider').textContent).toContain(
            'Production Provider'
        );
        expect(screen.getByLabelText('Translation provider').textContent).toContain(
            'ID production-provider'
        );
        expect(screen.getByLabelText('Translation provider').textContent).toContain(
            'Text production-text-model'
        );
        expect(screen.getByLabelText('Translation provider').textContent).toContain(
            'Vision production-vision-model'
        );
        expect(screen.getByLabelText('Translation provider').textContent).toContain(
            'Used production-used-model'
        );
    });

    it('streams updates and exposes copy speak pin close retry cancel through user actions', async () => {
        const user = userEvent.setup();
        const onCopy = vi.fn();
        const onSpeak = vi.fn();
        const onTogglePin = vi.fn();
        const onClose = vi.fn();
        const onCancel = vi.fn();
        render(
            <TranslationBubble
                task={{ ...completedTask, id: 'running-task', status: 'running', translatedText: '' }}
                streamDelta="你好"
                onCopy={onCopy}
                onSpeak={onSpeak}
                onTogglePin={onTogglePin}
                onClose={onClose}
                onCancel={onCancel}
            />
        );

        expect(screen.getByLabelText('Translation output').textContent).toContain('你好');
        await user.click(screen.getByRole('button', { name: 'Copy translation' }));
        await user.click(screen.getByRole('button', { name: 'Speak translation offline' }));
        await user.click(screen.getByRole('button', { name: 'Pin translation' }));
        await user.click(screen.getByRole('button', { name: 'Cancel translation' }));
        await user.click(screen.getByRole('button', { name: 'Close translation' }));

        expect(onCopy).toHaveBeenCalledTimes(1);
        expect(onSpeak).toHaveBeenCalledTimes(1);
        expect(onTogglePin).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps a pinned result visible until unpinned or explicitly closed', async () => {
        const user = userEvent.setup();

        function Harness(): React.JSX.Element {
            const [task, setTask] = useState(completedTask);
            return (
                <>
                    <button type="button" onClick={() => setTask({
                        ...completedTask,
                        id: 'task-2',
                        sourceText: 'new source',
                        translatedText: '新结果'
                    })}>
                        Replace result
                    </button>
                    <TranslationBubble task={task} />
                </>
            );
        }

        render(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Pin translation' }));
        await user.click(screen.getByRole('button', { name: 'Replace result' }));
        expect(screen.getByLabelText('Translation output').textContent).toContain('你好');

        await user.click(screen.getByRole('button', { name: 'Unpin translation' }));
        expect(screen.getByLabelText('Translation output').textContent).toContain('新结果');

        await user.click(screen.getByRole('button', { name: 'Pin translation' }));
        await user.click(screen.getByRole('button', { name: 'Replace result' }));
        await user.click(screen.getByRole('button', { name: 'Close translation' }));
        expect(screen.queryByLabelText('Translation result')).toBeNull();
    });

    it('uses the pinned task for copy speak cancel and retry availability', async () => {
        const user = userEvent.setup();
        const onCopy = vi.fn();
        const onSpeak = vi.fn();
        const onCancel = vi.fn();

        function Harness(): React.JSX.Element {
            const [task, setTask] = useState(completedTask);
            return (
                <>
                    <button type="button" onClick={() => setTask({
                        ...completedTask,
                        id: 'running-task',
                        status: 'running',
                        sourceText: 'replacement source',
                        translatedText: ''
                    })}>
                        Replace with running task
                    </button>
                    <TranslationBubble
                        task={task}
                        onCopy={onCopy}
                        onSpeak={onSpeak}
                        onCancel={onCancel}
                    />
                </>
            );
        }

        render(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Pin translation' }));
        await user.click(screen.getByRole('button', { name: 'Replace with running task' }));

        expect((screen.getByRole('button', {
            name: 'Retry translation'
        }) as HTMLButtonElement).disabled).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Copy translation' }));
        await user.click(screen.getByRole('button', { name: 'Speak translation offline' }));
        expect(onCopy).toHaveBeenCalledWith('你好');
        expect(onSpeak).toHaveBeenCalledWith('你好');

        await user.click(screen.getByRole('button', { name: 'Unpin translation' }));
        await user.click(screen.getByRole('button', { name: 'Cancel translation' }));
        expect(onCancel).toHaveBeenCalledWith('running-task');
    });

    it('disables retry while running and reuses the exact failed task source text', async () => {
        const user = userEvent.setup();
        const onRetry = vi.fn();
        const { rerender } = render(
            <TranslationBubble
                task={{ ...completedTask, id: 'running', status: 'running', translatedText: '' }}
                onRetry={onRetry}
            />
        );
        expect((screen.getByRole('button', {
            name: 'Retry translation'
        }) as HTMLButtonElement).disabled).toBe(true);

        rerender(
            <TranslationBubble
                task={{
                    ...completedTask,
                    id: 'failed',
                    status: 'failed',
                    sourceText: 'exact retry source',
                    translatedText: ''
                }}
                onRetry={onRetry}
            />
        );
        await user.click(screen.getByRole('button', { name: 'Retry translation' }));
        expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
            sourceText: 'exact retry source'
        }));
    });

    it('prevents overlapping retry requests', async () => {
        const user = userEvent.setup();
        let resolveRetry: (() => void) | undefined;
        const onRetry = vi.fn(() => new Promise<void>((resolve) => {
            resolveRetry = resolve;
        }));
        render(<TranslationBubble task={completedTask} onRetry={onRetry} />);

        await user.click(screen.getByRole('button', { name: 'Retry translation' }));
        await user.click(screen.getByRole('button', { name: 'Retry translation' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
        resolveRetry?.();
        await waitFor(() => expect((screen.getByRole('button', {
            name: 'Retry translation'
        }) as HTMLButtonElement).disabled).toBe(false));
    });

    it('presents typed recoverable failures without hiding retry', () => {
        render(
            <TranslationBubble
                task={{
                    ...completedTask,
                    status: 'failed',
                    translatedText: '',
                    error: 'Provider rate limit exceeded.',
                    errorCode: 'rate-limited'
                }}
            />
        );

        expect(screen.getByRole('alert').getAttribute('data-error-code')).toBe('rate-limited');
        expect((screen.getByRole('button', {
            name: 'Retry translation'
        }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('copies and speaks translation through browser primitives without network', async () => {
        const writeText = vi.fn(async () => undefined);
        await copyTranslation('你好', { writeText });
        expect(writeText).toHaveBeenCalledWith('你好');

        const speak = vi.fn();
        speakTranslation('你好', { speak });
        expect(speak).toHaveBeenCalledTimes(1);
    });
});
