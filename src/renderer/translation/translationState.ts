import type { TranslationEvent, TranslationTask } from '../../shared/contracts';

export interface TranslationBubbleState {
    task: TranslationTask;
    streamDelta: string;
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
            return event.taskId === state.task.id
                ? {
                    ...state,
                    streamDelta: state.streamDelta + event.delta
                }
                : state;
        case 'completed':
            return event.task.id === state.task.id
                ? {
                    task: event.task,
                    streamDelta: event.task.translatedText
                }
                : state;
        case 'failed':
            return event.taskId === state.task.id
                ? {
                    task: {
                        ...state.task,
                        id: event.taskId,
                        status: 'failed',
                        translatedText: state.streamDelta,
                        error: event.error.message,
                        errorCode: event.error.code
                    },
                    streamDelta: state.streamDelta
                }
                : state;
    }
}
