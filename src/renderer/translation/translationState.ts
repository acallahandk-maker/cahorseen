import type {
    TranslationError,
    TranslationEvent,
    TranslationRetryInput,
    TranslationTask
} from '../../shared/contracts';

export interface TranslationBubbleState {
    task: TranslationTask;
    streamDelta: string;
}

export type TranslationRetryContext = TranslationRetryInput;

export function isSelectionCaptureRetry(task: TranslationTask): boolean {
    return task.status === 'failed'
        && task.retryInput.kind === 'selection-capture';
}

export function createFailedTranslationTask(
    current: TranslationTask,
    retry: TranslationRetryContext,
    error: TranslationError
): TranslationTask {
    const taskWithoutBounds = { ...current };
    delete taskWithoutBounds.bounds;
    return {
        ...(retry.kind === 'selection' ? taskWithoutBounds : current),
        sourceText: retry.kind === 'selection' ? retry.sourceText : current.sourceText,
        retryInput: retry,
        status: 'failed',
        error: error.message,
        errorCode: error.code
    };
}

export function translationBubbleReducer(
    state: TranslationBubbleState,
    event: TranslationEvent
): TranslationBubbleState {
    switch (event.type) {
        case 'started':
            return {
                ...state,
                task: {
                    ...state.task,
                    id: event.taskId,
                    status: 'running'
                }
            };
        case 'delta':
            return event.taskId === state.task.id && state.task.status === 'running'
                ? {
                    ...state,
                    streamDelta: state.streamDelta + event.delta
                }
                : state;
        case 'completed':
            return event.task.id === state.task.id && state.task.status === 'running'
                ? {
                    task: event.task,
                    streamDelta: event.task.translatedText
                }
                : state;
        case 'failed':
            return event.taskId === state.task.id && state.task.status === 'running'
                ? {
                    task: event.task,
                    streamDelta: state.streamDelta
                }
                : state;
    }
}
