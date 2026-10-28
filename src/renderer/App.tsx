interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
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
