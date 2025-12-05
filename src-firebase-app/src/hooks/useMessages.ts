import { useState, useEffect, useCallback } from 'react';
import { collection, query, orderBy, limit, getDocs, startAfter, QueryDocumentSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { Message } from '../types';
import { useData } from '../context/DataContext';

const CHUNK_SIZE = 20;

export const useMessages = () => {
    const { recentMessages, loading: contextLoading } = useData();
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot | null>(null);
    const [hasMore, setHasMore] = useState(true);

    // Initialize with recent messages from context if available
    useEffect(() => {
        if (!contextLoading && recentMessages.length > 0 && messages.length === 0) {
            setMessages(recentMessages);
            setLoading(false);
        }
    }, [recentMessages, contextLoading, messages.length]);

    const loadInitialMessages = useCallback(async () => {
        // If we already have messages (from context), don't re-fetch unless forced or empty
        if (messages.length > 0) return;

        const user = auth.currentUser;
        if (!user) {
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            setError(null);
            const messagesRef = collection(db, 'users', user.uid, 'messages');
            const q = query(
                messagesRef,
                orderBy('id', 'desc'),
                limit(CHUNK_SIZE)
            );

            const snapshot = await getDocs(q);
            const messagesData = snapshot.docs.map(doc => doc.data() as Message);

            setMessages(messagesData);

            if (snapshot.docs.length > 0) {
                setLastDoc(snapshot.docs[snapshot.docs.length - 1]);
                setHasMore(snapshot.docs.length === CHUNK_SIZE);
            } else {
                setLastDoc(null);
                setHasMore(false);
            }
        } catch (err) {
            console.error("Error fetching messages:", err);
            setError("메시지를 불러오는데 실패했습니다");
        } finally {
            setLoading(false);
        }
    }, [messages.length]);

    const loadMoreMessages = useCallback(async () => {
        const user = auth.currentUser;
        // If we don't have lastDoc (e.g. initial load was from context), we need to find the last doc of current messages
        // But context doesn't give us docs, only data.
        // So if we loaded from context, we might need to fetch the "next" chunk by ID or just re-fetch properly.

        // Strategy: If we loaded from context, we don't have `lastDoc`.
        // We can query startAfter the last message ID we have.

        if (!user || (!lastDoc && messages.length === 0) || !hasMore || loadingMore) {
            return;
        }

        try {
            setLoadingMore(true);
            setError(null);
            const messagesRef = collection(db, 'users', user.uid, 'messages');

            let q;
            if (lastDoc) {
                q = query(
                    messagesRef,
                    orderBy('id', 'desc'),
                    startAfter(lastDoc),
                    limit(CHUNK_SIZE)
                );
            } else if (messages.length > 0) {
                // Fallback: use the ID of the last message
                const lastMessage = messages[messages.length - 1];
                q = query(
                    messagesRef,
                    orderBy('id', 'desc'),
                    startAfter(lastMessage.id), // Assuming ID is sortable/compatible with orderBy
                    limit(CHUNK_SIZE)
                );
            } else {
                return;
            }

            const snapshot = await getDocs(q);
            const newMessages = snapshot.docs.map(doc => doc.data() as Message);

            setMessages(prev => [...prev, ...newMessages]);

            if (snapshot.docs.length > 0) {
                setLastDoc(snapshot.docs[snapshot.docs.length - 1]);
                setHasMore(snapshot.docs.length === CHUNK_SIZE);
            } else {
                setLastDoc(null);
                setHasMore(false);
            }
        } catch (err) {
            console.error("Error loading more messages:", err);
            setError("더 많은 메시지를 불러오는데 실패했습니다");
        } finally {
            setLoadingMore(false);
        }
    }, [lastDoc, hasMore, loadingMore, messages]);

    useEffect(() => {
        loadInitialMessages();
    }, [loadInitialMessages]);

    return { messages, loading, loadingMore, error, hasMore, loadMoreMessages };
};
