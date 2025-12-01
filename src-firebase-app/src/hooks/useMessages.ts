import { useState, useEffect } from 'react';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { Message } from '../types';

export const useMessages = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const user = auth.currentUser;
        if (!user) {
            setLoading(false);
            return;
        }

        setLoading(true);
        const messagesRef = collection(db, 'users', user.uid, 'messages');
        // Assuming messages have a receive_date or similar to order by
        const q = query(messagesRef, orderBy('id', 'desc'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const messagesData = snapshot.docs.map(doc => doc.data() as Message);
            setMessages(messagesData);
            setLoading(false);
        }, (err) => {
            console.error("Error fetching messages:", err);
            setError("Failed to fetch messages");
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    return { messages, loading, error };
};
