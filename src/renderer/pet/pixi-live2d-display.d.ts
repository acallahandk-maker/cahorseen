declare module '@pixi/unsafe-eval' {
    export function install(PIXI: {
        systems: {
            ShaderSystem: unknown;
        };
    }): void;
}

declare module 'pixi-live2d-display/lib/cubism4' {
    export const Live2DModel: {
        from(
            source: string,
            options: {
                autoUpdate: false;
                autoInteract: true;
            }
        ): Promise<unknown>;
    };
}
