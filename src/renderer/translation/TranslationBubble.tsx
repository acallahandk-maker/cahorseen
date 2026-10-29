import { useRef, useState } from 'react';
import type { TranslationTask } from '../../shared/contracts';

export interface TranslationDisplayDetails {
    sourceLanguage?: string;
    providerId?: string;
    providerName?: string;
    textModel?: string;
    visionModel?: string;
    modelName?: string;
}

export interface TranslationBubbleProps {
    task: TranslationTask;
    streamDelta?: string;
    details?: TranslationDisplayDetails;
    pinned?: boolean;
    busy?: boolean;
    onCancel?: (taskId: string) => void;
    onCopy?: (text: string) => void;
    onSpeak?: (text: string) => void;
    onRetry?: (task: TranslationTask) => void | Promise<void>;
    onTogglePin?: (pinned: boolean) => void;
    onClose?: () => void;
}

export interface ClipboardLike {
    writeText(value: string): Promise<void>;
}

export interface SpeechSynthesisLike {
    speak(utterance: SpeechSynthesisUtterance): void;
}

interface PinnedFrame {
    task: TranslationTask;
    streamDelta: string;
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
    streamDelta = '',
    details,
    pinned,
    busy = false,
    onCancel,
    onCopy,
    onSpeak,
    onRetry,
    onTogglePin,
    onClose
}: TranslationBubbleProps): React.JSX.Element | null {
    const latestFrame = useRef<PinnedFrame>({ task, streamDelta });
    latestFrame.current = { task, streamDelta };
    const [pinnedFrame, setPinnedFrame] = useState<PinnedFrame>();
    const [closed, setClosed] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const retryingRef = useRef(false);
    const displayedFrame = pinnedFrame ?? latestFrame.current;
    const isPinned = pinned ?? pinnedFrame !== undefined;

    if (closed)
        return null;

    const displayedTask = displayedFrame.task;
    const translation = displayedTask.status === 'running'
        ? displayedFrame.streamDelta || displayedTask.translatedText
        : displayedTask.translatedText;
    const sourceLanguage = details?.sourceLanguage
        ?? displayedTask.sourceLanguage
        ?? 'und';
    const providerId = details?.providerId ?? displayedTask.providerId;
    const providerName = details?.providerName ?? displayedTask.providerName;
    const textModel = details?.textModel ?? displayedTask.textModel;
    const visionModel = details?.visionModel ?? displayedTask.visionModel;
    const translationModel = details?.modelName
        ?? displayedTask.translationModel
        ?? textModel;
    const providerDetails = [
        providerName ?? providerId,
        providerId === undefined || providerName === undefined ? undefined : `ID ${providerId}`,
        textModel === undefined ? undefined : `Text ${textModel}`,
        visionModel === undefined ? undefined : `Vision ${visionModel}`,
        translationModel === undefined ? undefined : `Used ${translationModel}`
    ].filter(Boolean).join(' · ');
    const retryDisabled = busy
        || displayedTask.status === 'running'
        || latestFrame.current.task.status === 'running'
        || retrying;

    const togglePin = (): void => {
        const nextPinned = !isPinned;
        if (pinned === undefined)
            setPinnedFrame(nextPinned ? latestFrame.current : undefined);
        onTogglePin?.(nextPinned);
    };

    const retry = async (): Promise<void> => {
        if (retryDisabled || retryingRef.current)
            return;
        retryingRef.current = true;
        setRetrying(true);
        try {
            await onRetry?.(displayedTask);
        } finally {
            retryingRef.current = false;
            setRetrying(false);
        }
    };

    return (
        <section
            aria-label="Translation result"
            data-pinned={isPinned ? 'true' : 'false'}
            data-task-id={displayedTask.id}
        >
            <header>
                <span>{sourceLanguage} → {displayedTask.targetLanguage}</span>
                <span>{displayedTask.status}</span>
            </header>
            {providerDetails.length === 0 ? null : (
                <p aria-label="Translation provider" data-provider-id={providerId}>
                    {providerDetails}
                </p>
            )}
            <p aria-label="Translation source">{displayedTask.sourceText}</p>
            <output aria-label="Translation output">{translation}</output>
            {displayedTask.error === undefined ? null : (
                <p role="alert" data-error-code={displayedTask.errorCode}>
                    {displayedTask.error}
                </p>
            )}
            <footer>
                <button type="button" aria-label="Copy translation" onClick={() => onCopy?.(translation)}>Copy</button>
                <button type="button" aria-label="Speak translation offline" onClick={() => onSpeak?.(translation)}>Speak</button>
                <button
                    type="button"
                    aria-label={isPinned ? 'Unpin translation' : 'Pin translation'}
                    aria-pressed={isPinned}
                    onClick={togglePin}
                >
                    {isPinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                    type="button"
                    aria-label="Retry translation"
                    disabled={retryDisabled}
                    onClick={() => void retry()}
                >
                    Retry
                </button>
                {displayedTask.status === 'running' ? (
                    <button type="button" aria-label="Cancel translation" onClick={() => onCancel?.(displayedTask.id)}>Cancel</button>
                ) : null}
                <button type="button" aria-label="Close translation" onClick={() => {
                    setClosed(true);
                    onClose?.();
                }}>Close</button>
            </footer>
        </section>
    );
}
