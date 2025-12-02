import { useState, useEffect, useCallback } from 'react';
import { collection, query, orderBy, limit, getDocs, startAfter, QueryDocumentSnapshot, where } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { Message } from '../types';

const CHUNK_SIZE = 4;
const CACHE_DURATION = 5 * 60 * 1000; // 5분

// 날짜 범위별 메시지 캐시 (월별로 캐싱)
const messagesCacheByMonth: Map<string, Message[]> = new Map();
const messagesCacheTimeByMonth: Map<string, number> = new Map();

// 날짜 범위에 해당하는 메시지를 가져오는 함수 (달력용, lazy loading)
// 전월, 현재월, 후월까지의 메시지를 로드하여 읽기 비용 최소화
export const useMessagesForDateRange = (startDate: Date, endDate: Date, currentMonth?: number, currentYear?: number) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const user = auth.currentUser;
        if (!user) {
            setLoading(false);
            return;
        }

        // 캐시 키 생성 (년-월 형식, 현재 월 기준)
        // 전월~후월 범위이지만 현재 월을 기준으로 캐싱
        const cacheKey = currentYear !== undefined && currentMonth !== undefined 
            ? `${currentYear}-${currentMonth}`
            : `${startDate.getFullYear()}-${startDate.getMonth() + 1}`;
        
        // 캐시 확인 (5분 이내 데이터 재사용)
        const now = Date.now();
        const cachedMessages = messagesCacheByMonth.get(cacheKey);
        const cacheTime = messagesCacheTimeByMonth.get(cacheKey);
        
        if (cachedMessages && cacheTime && (now - cacheTime) < CACHE_DURATION) {
            console.log(`Using cached messages for ${cacheKey}:`, cachedMessages.length);
            setMessages(cachedMessages);
            setLoading(false);
            return;
        }

        setLoading(true);
        const messagesRef = collection(db, 'users', user.uid, 'messages');
        
        // 서버 사이드 필터링: 
        // 1. deadline 필드가 있는 메시지만
        // 2. 전월 1일부터 후월 마지막일까지의 날짜 범위에 해당하는 메시지만
        // 
        // 날짜 범위: 전월 1일 ~ 후월 마지막일 (약 3개월 범위)
        // deadline이 이 범위에 포함되는 메시지만 읽기
        try {
            // ISO 날짜 문자열로 변환
            const startDateStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD
            const endDateStr = endDate.toISOString().split('T')[0];
            
            // 서버 사이드 필터링: deadline이 범위 내에 있는 메시지만 읽기
            // Firestore는 하나의 필드에 대해 범위 쿼리 지원: deadline >= startDate AND deadline <= endDate
            // 
            // 주의: schedule 필드가 있는 기간 일정은 별도로 처리해야 하므로
            // 먼저 deadline 범위로 필터링하고, 클라이언트에서 schedule도 확인
            const q = query(
                messagesRef,
                where('deadline', '>=', startDateStr),
                where('deadline', '<=', endDateStr),
                orderBy('deadline', 'asc')
            );

            getDocs(q).then((snapshot) => {
                const messagesData = snapshot.docs.map(doc => {
                    const data = doc.data();
                    return {
                        ...data,
                        _rawData: data
                    } as Message & { _rawData?: any };
                }) as Message[];
                
                // 서버에서 이미 날짜 범위로 필터링되었지만, 
                // schedule 필드가 있는 기간 일정도 추가로 확인
                // (기간 일정은 startDate/endDate가 범위와 겹치면 표시)
                const filteredMessages = messagesData.filter(msg => {
                    const msgData = msg as any;
                    const deadline = msgData.deadline || msgData._rawData?.deadline;
                    
                    // deadline이 있는 경우는 이미 서버에서 필터링됨
                    if (deadline) {
                        return true;
                    }
                    
                    // schedule 필드가 있는 경우 (기간 일정) - 클라이언트에서 확인
                    const schedule = msgData.schedule || msgData._rawData?.schedule;
                    if (schedule && schedule.startDate && schedule.endDate) {
                        const scheduleStart = new Date(schedule.startDate);
                        const scheduleEnd = new Date(schedule.endDate);
                        // 기간 일정이 현재 보이는 범위와 겹치는지 확인
                        return (scheduleStart <= endDate && scheduleEnd >= startDate);
                    }
                    
                    return false;
                });
                
                console.log(`Loaded messages for date range ${startDateStr} ~ ${endDateStr}: ${filteredMessages.length} (from ${messagesData.length} total)`);
                
                // 캐시 업데이트
                messagesCacheByMonth.set(cacheKey, filteredMessages);
                messagesCacheTimeByMonth.set(cacheKey, now);
                
                setMessages(filteredMessages);
                setLoading(false);
            }).catch((err: any) => {
                // Firestore 쿼리 제한 또는 인덱스 오류 시 fallback
                if (err.code === 'failed-precondition' || err.message?.includes('index') || err.code === 'invalid-argument') {
                    console.warn('Firestore query limitation. Using fallback:', err);
                    
                    // Fallback: deadline이 있는 모든 메시지를 읽고 클라이언트에서 날짜 범위 필터링
                    // 인덱스가 없거나 쿼리가 복잡한 경우
                    const fallbackQ = query(
                        messagesRef,
                        where('deadline', '!=', null),
                        orderBy('deadline', 'asc')
                    );
                    
                    getDocs(fallbackQ).then((snapshot) => {
                        const messagesData = snapshot.docs.map(doc => {
                            const data = doc.data();
                            return {
                                ...data,
                                _rawData: data
                            } as Message & { _rawData?: any };
                        }) as Message[];
                        
                        // 클라이언트 사이드 필터링: 날짜 범위 내의 메시지만
                        const filteredMessages = messagesData.filter(msg => {
                            const msgData = msg as any;
                            const deadline = msgData.deadline || msgData._rawData?.deadline;
                            
                            if (deadline) {
                                const deadlineDate = new Date(deadline);
                                return deadlineDate >= startDate && deadlineDate <= endDate;
                            }
                            
                            const schedule = msgData.schedule || msgData._rawData?.schedule;
                            if (schedule && schedule.startDate && schedule.endDate) {
                                const scheduleStart = new Date(schedule.startDate);
                                const scheduleEnd = new Date(schedule.endDate);
                                return (scheduleStart <= endDate && scheduleEnd >= startDate);
                            }
                            
                            return false;
                        });
                        
                        console.log(`Loaded messages (fallback): ${filteredMessages.length} (from ${messagesData.length} total)`);
                        
                        messagesCacheByMonth.set(cacheKey, filteredMessages);
                        messagesCacheTimeByMonth.set(cacheKey, now);
                        
                        setMessages(filteredMessages);
                        setLoading(false);
                    }).catch((fallbackErr) => {
                        console.error("Error fetching messages (fallback):", fallbackErr);
                        setError("메시지를 불러오는데 실패했습니다");
                        setLoading(false);
                    });
                } else {
                    console.error("Error fetching messages:", err);
                    setError("메시지를 불러오는데 실패했습니다");
                    setLoading(false);
                }
            });
        } catch (err) {
            console.error("Error setting up query:", err);
            setError("메시지를 불러오는데 실패했습니다");
            setLoading(false);
        }

        return () => {
            // getDocs는 promise이므로 cleanup 불필요
        };
    }, [startDate, endDate]);

    return { messages, loading, error };
};

// 하위 호환성을 위한 기존 함수 (모든 메시지)
export const useAllMessages = () => {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), 0, 1); // 올해 1월 1일
    const endDate = new Date(now.getFullYear() + 1, 11, 31); // 내년 12월 31일
    return useMessagesForDateRange(startDate, endDate);
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
