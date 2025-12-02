import { useState, useEffect, useCallback } from 'react';
import { collection, query, orderBy, limit, getDocs, startAfter, QueryDocumentSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { Message } from '../types';

const CHUNK_SIZE = 4;

// 모든 메시지를 가져오는 함수 (달력용)
export const useAllMessages = () => {
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
        const q = query(messagesRef, orderBy('id', 'desc'));

        getDocs(q).then((snapshot) => {
            const messagesData = snapshot.docs.map(doc => {
                const data = doc.data();
                // 원본 데이터도 보관하여 모든 필드 접근 가능하도록
                return {
                    ...data,
                    _rawData: data
                } as Message & { _rawData?: any };
            }) as Message[];
            
            console.log('Loaded all messages for calendar:', messagesData.length);
            if (messagesData.length > 0) {
                console.log('First message structure:', {
                    id: messagesData[0].id,
                    keys: Object.keys(messagesData[0]),
                    rawKeys: Object.keys((messagesData[0] as any)._rawData || {})
                });
            }
            
            setMessages(messagesData);
            setLoading(false);
        }).catch((err) => {
            console.error("Error fetching all messages:", err);
            setError("메시지를 불러오는데 실패했습니다");
            setLoading(false);
        });

        return () => {
            // getDocs는 promise이므로 cleanup 불필요
        };
    }, []);

    return { messages, loading, error };
};

export const useMessages = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot | null>(null);
    const [hasMore, setHasMore] = useState(true);

    const loadInitialMessages = useCallback(async () => {
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
    }, []);

    const loadMoreMessages = useCallback(async () => {
        const user = auth.currentUser;
        if (!user || !lastDoc || !hasMore || loadingMore) {
            return;
        }

        try {
            setLoadingMore(true);
            setError(null);
            const messagesRef = collection(db, 'users', user.uid, 'messages');
            const q = query(
                messagesRef,
                orderBy('id', 'desc'),
                startAfter(lastDoc),
                limit(CHUNK_SIZE)
            );

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
    }, [lastDoc, hasMore, loadingMore]);

    useEffect(() => {
        loadInitialMessages();
    }, [loadInitialMessages]);

    return { messages, loading, loadingMore, error, hasMore, loadMoreMessages };
};
