import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Message, ManualTodo } from '../types';

interface ScheduleModalProps {
  scheduleModal: { open: boolean; id?: number };
  setScheduleModal: (modal: { open: boolean; id?: number }) => void;
  deadlines: Record<number, string | null>;
  setDeadlines: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  manualTodos: ManualTodo[];
  setManualTodos: React.Dispatch<React.SetStateAction<ManualTodo[]>>;
  allMessages: Message[];
  setAllMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  udbPath: string;
  saveToRegistry: (key: string, value: string) => Promise<void>;
  classified: Record<number, 'left' | 'right'>;
  setClassified: React.Dispatch<React.SetStateAction<Record<number, 'left' | 'right'>>>;
  parseDateFromText: (text: string, baseDate?: Date) => { date: string | null; time: string | null };
  decodeEntities: (html: string) => string;
}

const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const REG_KEY_CLASSIFIED = 'ClassifiedMap';

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  scheduleModal,
  setScheduleModal,
  deadlines,
  setDeadlines,
  manualTodos,
  setManualTodos,
  allMessages,
  setAllMessages,
  udbPath,
  saveToRegistry,
  classified,
  setClassified,
  parseDateFromText,
  decodeEntities,
}) => {
  if (!scheduleModal.open || scheduleModal.id === undefined) return null;

  const id = scheduleModal.id;
  const isManualTodo = manualTodos.some(t => t.id === id);
  const [modalMsg, setModalMsg] = useState<Message | null>(null);
  const [isLoadingModalMsg, setIsLoadingModalMsg] = useState(false);
  const [dateVal, setDateVal] = useState<string>('');
  const [timeVal, setTimeVal] = useState<string>('');
  const [parsedDateInfo, setParsedDateInfo] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });
  
  const pad = (n: number) => n.toString().padStart(2, '0');
  const now = new Date();
  const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  // 메시지 내용에서 날짜 파싱 및 초기값 설정
  useEffect(() => {
    const current = deadlines[id] || '';
    
    // 이미 deadline이 있으면 그것을 사용
    if (current) {
      const d = new Date(current);
      setDateVal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      setTimeVal(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
      return;
    }

    // 메시지 내용 파싱
    let contentToParse = '';
    if (isManualTodo) {
      const manualTodo = manualTodos.find(t => t.id === id);
      if (manualTodo) {
        contentToParse = manualTodo.content;
      }
    } else if (modalMsg) {
      contentToParse = modalMsg.content;
    }

    if (contentToParse) {
      // HTML 태그 제거하고 텍스트만 추출
      const textContent = contentToParse.replace(/<[^>]*>/g, '');
      
      // 메시지의 receiveDate를 기준으로 날짜 파싱
      let baseDate: Date | undefined = undefined;
      if (!isManualTodo && modalMsg?.receive_date) {
        try {
          baseDate = new Date(modalMsg.receive_date);
        } catch {
          // 파싱 실패 시 무시
        }
      }
      
      const parsed = parseDateFromText(textContent, baseDate);
      setParsedDateInfo(parsed);
      
      if (parsed.date) {
        setDateVal(parsed.date);
      } else {
        setDateVal(defaultDate);
      }
      
      if (parsed.time) {
        setTimeVal(parsed.time);
      } else {
        setTimeVal(defaultTime);
      }
    } else {
      // 파싱할 내용이 없으면 기본값 사용
      setDateVal(defaultDate);
      setTimeVal(defaultTime);
    }
  }, [id, modalMsg, isManualTodo, manualTodos, deadlines, defaultDate, defaultTime, parseDateFromText]);

  useEffect(() => {
    if (isManualTodo) {
      // 수동 할 일인 경우 메시지 로드 불필요
      return;
    }
    
    const loadMsg = async () => {
      const found = allMessages.find((m) => m.id === id);
      if (found) {
        setModalMsg(found);
      } else if (udbPath) {
        setIsLoadingModalMsg(true);
        try {
          const msg: Message = await invoke('get_message_by_id', { dbPath: udbPath, id });
          setModalMsg(msg);
          // 메시지를 allMessages에 추가
          setAllMessages(prev => {
            if (prev.find(m => m.id === id)) return prev;
            return [...prev, msg];
          });
        } catch (e) {
          console.error("Failed to load message for modal", e);
        } finally {
          setIsLoadingModalMsg(false);
        }
      }
    };
    void loadMsg();
    
    // 모달이 닫히면 초기화
    return () => {
      setModalMsg(null);
      setIsLoadingModalMsg(false);
      setDateVal('');
      setTimeVal('');
      setParsedDateInfo({ date: null, time: null });
    };
  }, [id, udbPath, allMessages, isManualTodo, setAllMessages]);

  const onSave = () => {
    const iso = new Date(`${dateVal}T${timeVal}:00`).toISOString();
    
    if (isManualTodo) {
      // 수동 할 일의 경우 manualTodos 업데이트
      setManualTodos(prev => {
        const next = prev.map(t => t.id === id ? { ...t, deadline: iso } : t);
        void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
        return next;
      });
      // deadlines에도 저장 (일관성 유지)
      setDeadlines(prev => {
        const next = { ...prev, [id]: iso };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
    } else {
      setDeadlines(prev => {
        const next = { ...prev, [id]: iso };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
      if (classified[id] !== 'right') {
        setClassified(prev => {
          const next = { ...prev, [id]: 'right' as const };
          void saveToRegistry(REG_KEY_CLASSIFIED, JSON.stringify(next));
          return next;
        });
      }
    }
    setScheduleModal({ open: false });
  };

  const onNoDeadline = () => {
    if (isManualTodo) {
      setManualTodos(prev => {
        const next = prev.map(t => t.id === id ? { ...t, deadline: null } : t);
        void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
        return next;
      });
      setDeadlines(prev => {
        const next = { ...prev, [id]: null };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
    } else {
      setDeadlines(prev => {
        const next = { ...prev, [id]: null };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
    }
    setScheduleModal({ open: false });
  };

  const manualTodo = isManualTodo ? manualTodos.find(t => t.id === id) : null;

  return (
      <div className="schedule-modal-overlay" onClick={() => setScheduleModal({ open: false }) }>
          <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
            <div className="schedule-inner">
              <div className="schedule-preview">
                {isManualTodo ? (
                  manualTodo ? (
                    <div dangerouslySetInnerHTML={{ __html: decodeEntities(manualTodo.content) }} />
                  ) : (
                    <div>할 일을 불러올 수 없습니다.</div>
                  )
                ) : isLoadingModalMsg ? (
                  <div>로딩 중...</div>
                ) : modalMsg ? (
                  <div dangerouslySetInnerHTML={{ __html: decodeEntities(modalMsg.content) }} />
                ) : (
                  <div>메시지를 불러올 수 없습니다.</div>
                )}
              </div>
              <div className="schedule-panel">
                <h3>완료 시간 설정</h3>
                {parsedDateInfo.date && (
                  <div style={{ 
                    marginBottom: '12px', 
                    padding: '8px', 
                    backgroundColor: 'var(--bg-light)', 
                    borderRadius: 'var(--radius)',
                    fontSize: '13px',
                    color: 'var(--primary)'
                  }}>
                    📅 날짜가 자동으로 감지되었습니다: {parsedDateInfo.date} {parsedDateInfo.time ? `(${parsedDateInfo.time})` : ''}
                  </div>
                )}
                <label htmlFor="deadline-date">날짜</label>
                <input 
                  id="deadline-date" 
                  type="date" 
                  value={dateVal || defaultDate}
                  onChange={(e) => setDateVal(e.target.value)} 
                />
                <label htmlFor="deadline-time">시간</label>
                <input 
                  id="deadline-time" 
                  type="time" 
                  value={timeVal || defaultTime}
                  onChange={(e) => setTimeVal(e.target.value)} 
                />
                <div className="row">
                  <button onClick={onSave}>저장</button>
                  <button onClick={onNoDeadline}>완료 시간 없음</button>
                  <button onClick={() => setScheduleModal({ open: false })}>취소</button>
                </div>
              </div>
            </div>
          </div>
      </div>
  );
};
