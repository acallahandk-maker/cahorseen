export type MascotState =
    | 'idle'
    | 'listening'
    | 'thinking'
    | 'success'
    | 'error'
    | 'quizzing'
    | 'happy'
    | 'sad';

export type MascotEvent = MascotState;

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
        sad: 'sad'
    },
    happy: {
        idle: 'idle'
    },
    sad: {
        idle: 'idle'
    }
};

export function transitionMascotState(current: MascotState, event: MascotEvent): MascotState {
    const next = transitions[current]?.[event];
    if (!next)
        throw new Error(`Unknown mascot transition: ${current} -> ${event}`);
    return next;
}
