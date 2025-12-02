import { signInWithCustomToken, signOut, User, onAuthStateChanged, GoogleAuthProvider, signInWithCredential } from "firebase/auth";
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { open } from '@tauri-apps/plugin-shell';
import { listen } from '@tauri-apps/api/event';
import { auth } from "../firebase";

const processUrl = (url: string) => {
    if (url.startsWith('hypercool://auth/callback')) {
        try {
            const urlObj = new URL(url);
            const token = urlObj.searchParams.get('token');
            const type = urlObj.searchParams.get('type');

            if (token) {
                if (type === 'google') {
                    const credential = GoogleAuthProvider.credential(token);
                    signInWithCredential(auth, credential)
                        .then(() => {
                            console.log('Successfully signed in with Google credential');
                            // Force UI update or notify user if needed
                            alert('Successfully signed in!');
                        })
                        .catch((e) => {
                            console.error('Error signing in with Google credential:', e);
                            alert('Sign in failed: ' + e.message);
                        });
                } else {
                    signInWithCustomToken(auth, token)
                        .then(() => console.log('Successfully signed in with custom token'))
                        .catch((e) => console.error('Error signing in with custom token:', e));
                }
            }
        } catch (e) {
            console.error('Error parsing deep link URL:', e);
        }
    }
};

export const AuthService = {
    init: async () => {
        try {
            // Listen for deep links (standard plugin)
            await onOpenUrl((urls: string[]) => {
                console.log('Deep link received (plugin):', urls);
                urls.forEach(processUrl);
            });

            // Listen for deep links (single-instance event)
            await listen<string>('deep-link-url', (event) => {
                console.log('Deep link received (event):', event.payload);
                processUrl(event.payload);
            });

            console.log('Deep link listener initialized');
        } catch (e) {
            console.error('Failed to initialize deep link listener:', e);
        }
    },

    signIn: async () => {
        // Open system browser to the login page
        // For development, use localhost. In production, use the hosted URL.
        // TODO: Replace with production URL when deployed
        const loginUrl = 'https://hypercool-fe1fa.web.app/login';
        try {
            await open(loginUrl);
        } catch (e) {
            console.error('Failed to open login URL:', e);
        }
    },

    signOut: () => signOut(auth),

    onAuthStateChanged: (callback: (user: User | null) => void) => {
        return onAuthStateChanged(auth, callback);
    },

    getUser: () => auth.currentUser
};
