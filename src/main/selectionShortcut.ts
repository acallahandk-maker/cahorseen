export interface SelectionShortcutRegistrar {
    register(accelerator: string, listener: () => void): boolean;
    unregister(accelerator: string): void;
}

export interface SelectionShortcutOptions {
    shortcut: SelectionShortcutRegistrar;
    accelerator?: string;
    onTrigger(): void;
}

export const DEFAULT_SELECTION_SHORTCUT = 'CommandOrControl+Shift+T';

export function registerSelectionShortcut(
    options: SelectionShortcutOptions
): () => void {
    const accelerator = options.accelerator ?? DEFAULT_SELECTION_SHORTCUT;
    if (!options.shortcut.register(accelerator, options.onTrigger))
        throw new Error('Selection shortcut could not be registered.');
    return () => {
        options.shortcut.unregister(accelerator);
    };
}
