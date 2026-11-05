import {
    mascotEventSchema,
    mascotStateSchema,
    type MascotEvent,
    type MascotState
} from './contracts';

export type { MascotEvent, MascotState };

const transitions: Readonly<Record<MascotState, Readonly<Partial<Record<MascotEvent, MascotState>>>>> = {
    idle: {
        listening: 'listening',
        quizzing: 'quizzing'
    },
    listening: {
        thinking: 'thinking'
    },
    thinking: {
        success: 'success',
        error: 'error'
    },
    success: {},
    error: {},
    quizzing: {
        happy: 'happy',
        sad: 'sad',
        idle: 'idle'
    },
    happy: {
        idle: 'idle'
    },
    sad: {
        idle: 'idle'
    }
};

export function transitionMascotState(current: MascotState, event: MascotEvent): MascotState {
    const currentState = mascotStateSchema.parse(current);
    const currentEvent = mascotEventSchema.parse(event);
    const next = transitions[currentState]?.[currentEvent];
    if (!next)
        throw new Error(`Unknown mascot transition: ${currentState} -> ${currentEvent}`);
    return next;
}
