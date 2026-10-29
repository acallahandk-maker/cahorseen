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
    createFailedTranslationTask,
    isSelectionCaptureRetry,
    translationBubbleReducer,
    type TranslationBubbleState
} from '../../src/renderer/translation/translationState';
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
    it('reuses a known source exactly equal to the capture placeholder', () => {
        const task = {
            ...completedTask,
            kind: 'selection',
            status: 'failed',
            sourceText: 'Capturing selected text',
            retryInput: {
                kind: 'selection',
                strategy: 'reuse-source',
                sourceText: 'Capturing selected text'
            },
            error: 'Provider request was cancelled.',
            errorCode: 'aborted'
        } as TranslationTask;

        expect(isSelectionCaptureRetry(task)).toBe(false);
        expect(task.retryInput).toEqual({
            kind: 'selection',
            strategy: 'reuse-source',
            sourceText: 'Capturing selected text'
        });
    });

    it('recaptures a cancelled pending selection without treating placeholder text as source', () => {
        const task = {
            ...completedTask,
            kind: 'selection',
            status: 'failed',
            sourceText: 'Capturing selected text',
            retryInput: {
                kind: 'selection-capture',
                strategy: 'recapture'
            },
            error: 'Provider request was cancelled.',
            errorCode: 'aborted'
        } as TranslationTask;

        expect(isSelectionCaptureRetry(task)).toBe(true);
        expect(task.retryInput).toEqual({
            kind: 'selection-capture',
            strategy: 'recapture'
        });
        expect(task.retryInput).not.toHaveProperty('sourceText');

        const failure = createFailedTranslationTask(
            {
                ...completedTask,
                id: 'cancelled-capture',
                status: 'running',
                sourceText: 'Capturing selected text',
                translatedText: ''
            },
            task.retryInput,
            { code: 'aborted', message: 'Provider request was cancelled.' }
        );
        expect(failure.retryInput).toEqual({
            kind: 'selection-capture',
            strategy: 'recapture'
        });
        expect(failure.retryInput).not.toHaveProperty('sourceText');
        expect(failure.sourceText).toBe('Capturing selected text');
    });

    it('ignores stale capture completion after cancellation', () => {
        const runningState: TranslationBubbleState = {
            task: {
                ...completedTask,
                id: 'cancelled-capture',
                status: 'running',
                sourceText: 'Capturing selected text',
                translatedText: ''
            },
            streamDelta: ''
        };
        const cancelledState = translationBubbleReducer(runningState, {
            type: 'failed',
            taskId: 'cancelled-capture',
            error: {
                code: 'aborted',
                message: 'Provider request was cancelled.'
            },
            task: {
                ...runningState.task,
                status: 'failed',
                error: 'Provider request was cancelled.',
                errorCode: 'aborted'
            }
        });

        const staleState = translationBubbleReducer(cancelledState, {
            type: 'completed',
            task: {
                ...runningState.task,
                sourceText: 'exact stale selected text',
                translatedText: 'stale success',
                status: 'completed'
            }
        });

        expect(staleState).toBe(cancelledState);
        expect(staleState.task.status).toBe('failed');
        expect(staleState.task.errorCode).toBe('aborted');
    });

    it('constructs typed renderer fallback tasks with exact retry context and no image', () => {
        const runningTask: TranslationTask = {
            ...completedTask,
            kind: 'selection',
            id: 'fallback-running',
            status: 'running',
            sourceText: 'placeholder',
            translatedText: 'partial'
        };
        const selectionFailure = createFailedTranslationTask(
            runningTask,
            { kind: 'selection', sourceText: 'exact fallback selection' },
            { code: 'timeout', message: 'Provider request timed out.' }
        );
        const screenshotFailure = createFailedTranslationTask(
            {
                ...runningTask,
                kind: 'screenshot',
                sourceText: 'Screenshot region',
                bounds: { x: 4, y: 8, width: 640, height: 360 }
            },
            {
                kind: 'screenshot',
                bounds: { x: 4, y: 8, width: 640, height: 360 }
            },
            { code: 'network', message: 'Provider network failed.' }
        );

        expect(selectionFailure).toMatchObject({
            status: 'failed',
            kind: 'selection',
            sourceText: 'exact fallback selection',
            translatedText: 'partial',
            providerId: 'synthetic-provider',
            error: 'Provider request timed out.',
            errorCode: 'timeout'
        });
        expect(screenshotFailure).toMatchObject({
            status: 'failed',
            kind: 'screenshot',
            bounds: { x: 4, y: 8, width: 640, height: 360 },
            error: 'Provider network failed.',
            errorCode: 'network'
        });
        expect(JSON.stringify(screenshotFailure)).not.toContain('data:image');
    });

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

    it('retries a pinned renderer fallback failure with its exact source text', async () => {
        const user = userEvent.setup();
        const onRetry = vi.fn();
        const failedTask = createFailedTranslationTask(
            {
                ...completedTask,
                kind: 'selection',
                id: 'pinned-failed',
                status: 'running',
                sourceText: 'placeholder',
                translatedText: ''
            },
            { kind: 'selection', sourceText: 'pinned exact source' },
            { code: 'request-failed', message: 'Provider request failed.' }
        );

        function Harness(): React.JSX.Element {
            const [task, setTask] = useState(failedTask);
            return (
                <>
                    <button type="button" onClick={() => setTask({
                        ...completedTask,
                        id: 'replacement',
                        sourceText: 'replacement source'
                    })}>
                        Replace result
                    </button>
                    <TranslationBubble task={task} onRetry={onRetry} />
                </>
            );
        }

        render(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Pin translation' }));
        await user.click(screen.getByRole('button', { name: 'Replace result' }));
        await user.click(screen.getByRole('button', { name: 'Retry translation' }));

        expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
            id: 'pinned-failed',
            sourceText: 'pinned exact source'
        }));
    });

    it('retries a failed screenshot task with preserved bounds', async () => {
        const user = userEvent.setup();
        const onRetry = vi.fn();
        const bounds = { x: 12, y: 24, width: 320, height: 180 };
        render(
            <TranslationBubble
                task={{
                    ...completedTask,
                    id: 'failed-screenshot',
                    status: 'failed',
                    kind: 'screenshot',
                    sourceText: 'Screenshot region',
                    translatedText: '',
                    bounds,
                    error: 'Provider request failed.',
                    errorCode: 'request-failed'
                }}
                onRetry={onRetry}
            />
        );

        await user.click(screen.getByRole('button', { name: 'Retry translation' }));
        expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'screenshot',
            bounds
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
