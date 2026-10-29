declare module 'pixi-live2d-display/lib/cubism4' {
    export const Live2DModel: {
        from(
            source: string,
            options: {
                autoUpdate: false;
                autoInteract: false;
            }
        ): Promise<unknown>;
    };
}
