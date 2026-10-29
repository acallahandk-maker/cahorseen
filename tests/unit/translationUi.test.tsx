import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import TranslationBubble, {
    copyTranslation,
    speakTranslation
} from '../../src/renderer/translation/TranslationBubble';
import type { TranslationTask } from '../../src/shared/contracts';

const completedTask: TranslationTask = {
    id: 'task-1',
    status: 'completed',
    sourceText: 'hello',
    translatedText: '你好',
    targetLanguage: 'zh-CN'
};

describe('TranslationBubble', () => {
    it('renders streaming deltas and typed language/provider details', () => {
        const markup = renderToStaticMarkup(
            <TranslationBubble
                task={{
                    ...completedTask,
                    id: 'task-stream',
                    status: 'running',
                    translatedText: ''
                }}
                streamDelta="你好"
                details={{
                    sourceLanguage: 'en',
                    providerName: 'Synthetic Provider',
                    modelName: 'synthetic-text-model'
                }}
            />
        );

        expect(markup).toContain('你好');
        expect(markup).toContain('en');
        expect(markup).toContain('zh-CN');
        expect(markup).toContain('Synthetic Provider');
        expect(markup).toContain('synthetic-text-model');
    });

    it('exposes copy, speak, pin, retry, and cancel actions', () => {
        const markup = renderToStaticMarkup(
            <TranslationBubble
                task={{ ...completedTask, status: 'running' }}
                streamDelta="你好"
                pinned={false}
                onCopy={vi.fn()}
                onSpeak={vi.fn()}
                onTogglePin={vi.fn()}
                onRetry={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        expect(markup).toContain('aria-label="Copy translation"');
        expect(markup).toContain('aria-label="Speak translation offline"');
        expect(markup).toContain('aria-label="Pin translation"');
        expect(markup).toContain('aria-label="Retry translation"');
        expect(markup).toContain('aria-label="Cancel translation"');
    });

    it('presents recoverable typed failures without hiding retry', () => {
        const markup = renderToStaticMarkup(
            <TranslationBubble
                task={{
                    ...completedTask,
                    status: 'failed',
                    translatedText: '',
                    error: 'Provider rate limit exceeded.',
                    errorCode: 'rate-limited'
                }}
                onRetry={vi.fn()}
            />
        );

        expect(markup).toContain('role="alert"');
        expect(markup).toContain('data-error-code="rate-limited"');
        expect(markup).toContain('aria-label="Retry translation"');
    });

    it('copies through the injected clipboard without retaining secrets', async () => {
        const writeText = vi.fn(async () => undefined);
        await copyTranslation('你好', { writeText });

        expect(writeText).toHaveBeenCalledWith('你好');
    });

    it('speaks through window speech synthesis without network calls', () => {
        const speak = vi.fn();
        const cancel = vi.fn();
        const speechSynthesis = {
            speak,
            cancel,
            paused: false,
            pending: false,
            speaking: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            getVoices: vi.fn(() => []),
            resume: vi.fn(),
            pause: vi.fn()
        };

        speakTranslation('你好', speechSynthesis);

        expect(speak).toHaveBeenCalledTimes(1);
        expect(cancel).not.toHaveBeenCalled();
    });
});
