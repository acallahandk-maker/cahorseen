import type { TranslationTask } from '../../shared/contracts';

export interface TranslationDisplayDetails {
    sourceLanguage?: string;
    providerName?: string;
    modelName?: string;
}

export interface TranslationBubbleProps {
    task: TranslationTask;
    streamDelta?: string;
    details?: TranslationDisplayDetails;
    pinned?: boolean;
    onCancel?: () => void;
    onCopy?: () => void;
    onSpeak?: () => void;
    onRetry?: () => void;
    onTogglePin?: () => void;
}

export interface ClipboardLike {
    writeText(value: string): Promise<void>;
}

export interface SpeechSynthesisLike {
    speak(utterance: SpeechSynthesisUtterance): void;
}

export async function copyTranslation(
    text: string,
    clipboard: ClipboardLike = window.navigator.clipboard
): Promise<void> {
    await clipboard.writeText(text);
}

export function speakTranslation(
    text: string,
    speechSynthesis: SpeechSynthesisLike = window.speechSynthesis
): void {
    const utterance = typeof globalThis.SpeechSynthesisUtterance === 'function'
        ? new globalThis.SpeechSynthesisUtterance(text)
        : ({ text, lang: 'auto' } as SpeechSynthesisUtterance);
    utterance.lang = 'auto';
    speechSynthesis.speak(utterance);
}

export default function TranslationBubble({
    task,
    streamDelta,
    details,
    pinned = false,
    onCancel,
    onCopy,
    onSpeak,
    onRetry,
    onTogglePin
}: TranslationBubbleProps): React.JSX.Element {
    const translation = task.status === 'running'
        ? streamDelta ?? task.translatedText
        : task.translatedText;

    return (
        <section aria-label="Translation result" data-pinned={pinned ? 'true' : 'false'}>
            <header>
                <span>{details?.sourceLanguage ?? 'Source'} → {task.targetLanguage}</span>
                <span>{task.status}</span>
            </header>
            {details?.providerName === undefined ? null : (
                <p aria-label="Translation provider">
                    {details.providerName}
                    {details.modelName === undefined ? '' : ` · ${details.modelName}`}
                </p>
            )}
            <p aria-label="Translation source">{task.sourceText}</p>
            <output aria-label="Translation output">{translation}</output>
            {task.error === undefined ? null : (
                <p role="alert" data-error-code={task.errorCode}>{task.error}</p>
            )}
            <footer>
                <button type="button" aria-label="Copy translation" onClick={onCopy}>Copy</button>
                <button type="button" aria-label="Speak translation offline" onClick={onSpeak}>Speak</button>
                <button
                    type="button"
                    aria-label="Pin translation"
                    aria-pressed={pinned}
                    onClick={onTogglePin}
                >
                    {pinned ? 'Unpin' : 'Pin'}
                </button>
                <button type="button" aria-label="Retry translation" onClick={onRetry}>Retry</button>
                {task.status === 'running' ? (
                    <button type="button" aria-label="Cancel translation" onClick={onCancel}>Cancel</button>
                ) : null}
            </footer>
        </section>
    );
}
