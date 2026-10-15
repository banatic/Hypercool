import { useState, useEffect, useCallback, useMemo } from 'react';
import { collection, query, orderBy, limit, getDocs, startAfter } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { Message } from '../types';
import { useData, RECENT_MESSAGE_LIMIT } from '../context/DataStore';

const CHUNK_SIZE = RECENT_MESSAGE_LIMIT;

/**
 * 메시지 목록 = 컨텍스트가 실시간 구독하는 최근 N건 + 그 뒤로 페이지 단위로 더 불러온 것.
 * 첫 화면을 위해 따로 조회하지 않으며, 새 메시지는 컨텍스트를 통해 맨 위에 자동으로 나타난다.
 */
export const useMessages = () => {
    const { recentMessages, loading: contextLoading } = useData();
    const [older, setOlder] = useState<Message[]>([]);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [exhausted, setExhausted] = useState(false);

    // 로그아웃/재로그인으로 최근 목록이 비면 이어 붙인 것도 버린다.
    useEffect(() => {
        if (!contextLoading && recentMessages.length === 0) {
            setOlder([]);
            setExhausted(false);
        }
    }, [contextLoading, recentMessages.length]);

    const messages = useMemo(() => {
        const seen = new Set<number>();
        const out: Message[] = [];
        for (const m of [...recentMessages, ...older]) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            out.push(m);
        }
        return out;
    }, [recentMessages, older]);

    const hasMore = !contextLoading && !exhausted && recentMessages.length >= CHUNK_SIZE;

    const loadMoreMessages = useCallback(async () => {
        const user = auth.currentUser;
        if (!user || loadingMore || !hasMore || messages.length === 0) return;

        const lastId = messages[messages.length - 1].id;
        try {
            setLoadingMore(true);
            setError(null);
            const messagesRef = collection(db, 'users', user.uid, 'messages');
            const q = query(messagesRef, orderBy('id', 'desc'), startAfter(lastId), limit(CHUNK_SIZE));
            const snapshot = await getDocs(q);
            const next = snapshot.docs.map(d => d.data() as Message);
            setOlder(prev => [...prev, ...next]);
            if (next.length < CHUNK_SIZE) setExhausted(true);
        } catch (err) {
            console.error('Error loading more messages:', err);
            setError('이전 메시지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, hasMore, messages]);

    return { messages, loading: contextLoading, loadingMore, error, hasMore, loadMoreMessages };
};
