interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
    captureSelectionOnce: () => Promise<unknown>;
    translateSelection: (taskId?: string) => Promise<unknown>;
    cancelTranslation: (taskId: string) => Promise<void>;
    onTranslationEvent: (listener: (event: unknown) => void) => () => void;
}

declare global {
    interface Window {
        desktopPet: DesktopPetApi;
    }
}

export default function App(): React.JSX.Element {
    return (
        <main>
            <h1>Desktop Pet Translator</h1>
            <p>Application scaffold ready.</p>
        </main>
    );
}
