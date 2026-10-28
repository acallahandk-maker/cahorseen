import type { TranslationTask } from '../../shared/contracts';

export interface TranslationBubbleProps {
    task: TranslationTask;
    streamDelta?: string;
    onCancel?: () => void;
    onCopy?: () => void;
    onRetry?: () => void;
}

export default function TranslationBubble({
    task,
    streamDelta,
    onCancel,
    onCopy,
    onRetry
}: TranslationBubbleProps): React.JSX.Element {
    const translation = task.status === 'running'
        ? streamDelta ?? task.translatedText
        : task.translatedText;

    return (
        <section aria-label="Translation result">
            <header>
                <span>{task.targetLanguage}</span>
                <span>{task.status}</span>
            </header>
            <p aria-label="Translation source">{task.sourceText}</p>
            <output>{translation}</output>
            {task.error === undefined ? null : (
                <p role="alert" data-error-code={task.errorCode}>{task.error}</p>
            )}
            <footer>
                <button type="button" onClick={onCopy}>Copy</button>
                <button type="button" onClick={onRetry}>Retry</button>
                {task.status === 'running' ? (
                    <button type="button" onClick={onCancel}>Cancel</button>
                ) : null}
            </footer>
        </section>
    );
}
