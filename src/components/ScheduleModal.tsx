import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { Message, ManualTodo } from '../types';

interface ScheduleModalProps {
  scheduleModal: { open: boolean; id?: number | string };
  setScheduleModal: (modal: { open: boolean; id?: number | string }) => void;
  deadlines: Record<string, string | null>;
  setDeadlines: React.Dispatch<React.SetStateAction<Record<string, string | null>>>;
  calendarTitles: Record<string, string>;
  setCalendarTitles: React.Dispatch<React.SetStateAction<Record<string, string>>>;
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
  schedules: import('../types/schedule').ScheduleItem[];
}

const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const REG_KEY_CLASSIFIED = 'ClassifiedMap';
const REG_KEY_CALENDAR_TITLES = 'CalendarTitles';

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  scheduleModal,
  setScheduleModal,
  deadlines,
  setDeadlines,
  calendarTitles,
  setCalendarTitles,
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
  schedules,
}) => {
  if (!scheduleModal.open || scheduleModal.id === undefined) return null;

  const id = scheduleModal.id;
  const isManualTodo = manualTodos.some(t => t.id === id);
  const [modalMsg, setModalMsg] = useState<Message | null>(null);
  const [isLoadingModalMsg, setIsLoadingModalMsg] = useState(false);
  const [dateVal, setDateVal] = useState<string>('');
  const [timeVal, setTimeVal] = useState<string>('');
  const [parsedDateInfo, setParsedDateInfo] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });
  const [calendarTitle, setCalendarTitle] = useState<string>('');
  
  const pad = (n: number) => n.toString().padStart(2, '0');
  const now = new Date();
  const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  // id가 변경될 때만 초기값 설정 (입력값 보존)
  useEffect(() => {
    // 기존 calendarTitle 로드
    if (isManualTodo) {
      const manualTodo = manualTodos.find(t => t.id === id);
      if (manualTodo?.calendarTitle) {
        setCalendarTitle(manualTodo.calendarTitle);
      } else {
        setCalendarTitle(calendarTitles[id.toString()] || '');
      }
    } else {
      setCalendarTitle(calendarTitles[id.toString()] || '');
    }
    
    const current = deadlines[id.toString()] || '';
    
    // 이미 deadline이 있으면 그것을 사용
    if (current) {
      const d = new Date(current);
      setDateVal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      setTimeVal(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
      return;
    }

    // 수동 할 일인 경우 즉시 파싱
    if (isManualTodo) {
      const manualTodo = manualTodos.find(t => t.id === id);
      if (manualTodo) {
        const textContent = manualTodo.content.replace(/<[^>]*>/g, '');
        const parsed = parseDateFromText(textContent);
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
        setDateVal(defaultDate);
        setTimeVal(defaultTime);
      }
    } else {
      // 일반 메시지인 경우 기본값만 설정 (modalMsg 로드 후 파싱)
      setDateVal(defaultDate);
      setTimeVal(defaultTime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]); // id가 변경될 때만 실행하여 입력값 보존

  // modalMsg가 로드된 후 날짜 파싱 (사용자가 이미 입력한 값이 있으면 덮어쓰지 않음)
  useEffect(() => {
    if (isManualTodo || !modalMsg) return;
    
    // 이미 deadline이 있으면 파싱하지 않음
    const current = deadlines[id.toString()];
    if (current) return;
    
    // 사용자가 이미 입력한 값이 있으면 파싱하지 않음
    if (dateVal && dateVal !== defaultDate) return;
    if (timeVal && timeVal !== defaultTime) return;

    const textContent = modalMsg.content.replace(/<[^>]*>/g, '');
    let baseDate: Date | undefined = undefined;
    if (modalMsg.receive_date) {
      try {
        baseDate = new Date(modalMsg.receive_date);
      } catch {
        // 파싱 실패 시 무시
      }
    }
    
    const parsed = parseDateFromText(textContent, baseDate);
    setParsedDateInfo(parsed);
    
    if (parsed.date && (!dateVal || dateVal === defaultDate)) {
      setDateVal(parsed.date);
    }
    
    if (parsed.time && (!timeVal || timeVal === defaultTime)) {
      setTimeVal(parsed.time);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalMsg, id]); // modalMsg가 로드될 때만 실행

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
      setCalendarTitle('');
      setParsedDateInfo({ date: null, time: null });
    };
  }, [id, udbPath, allMessages, isManualTodo, setAllMessages]);

  const onSave = async () => {
    if (!dateVal || !timeVal) {
      alert('날짜와 시간을 모두 입력해주세요.');
      return;
    }

    const dateStr = `${dateVal}T${timeVal}:00`;
    const dateObj = new Date(dateStr);

    if (isNaN(dateObj.getTime())) {
      alert('유효하지 않은 날짜 형식입니다.');
      return;
    }

    const iso = dateObj.toISOString();
    const title = calendarTitle.trim();

    try {
      if (isManualTodo) {
        // Find existing schedule item
        // ManualTodo ID is the Schedule ID
        const existingItem = schedules.find(s => s.id === id);
        if (existingItem) {
          await import('../services/ScheduleService').then(m => m.ScheduleService.updateScheduleItem({
            ...existingItem,
            title: title || existingItem.title,
            startDate: iso,
            endDate: iso, // Point in time
            updatedAt: new Date().toISOString()
          }));
        } else {
          console.error("Manual todo not found in schedules list");
        }
      } else {
        // Message Task
        // Check if exists
        const existingItem = schedules.find(s => s.referenceId === id.toString() && s.type === 'message_task');
        if (existingItem) {
           await import('../services/ScheduleService').then(m => m.ScheduleService.updateScheduleItem({
            ...existingItem,
            title: title || existingItem.title,
            startDate: iso,
            endDate: iso,
            updatedAt: new Date().toISOString()
          }));
        } else {
          // Create new
          await import('../services/ScheduleService').then(m => m.ScheduleService.convertMessageToSchedule(
            typeof id === 'string' ? parseInt(id) : id,
            dateObj,
            title || "메시지 일정",
            modalMsg?.content
          ));
        }

        if (typeof id === 'number' && classified[id] !== 'right') {
          setClassified(prev => {
            const next = { ...prev, [id]: 'right' as const };
            void saveToRegistry(REG_KEY_CLASSIFIED, JSON.stringify(next));
            return next;
          });
        }
      }
      
      // 달력 업데이트 이벤트 발생
      void emit('calendar-update');
      setScheduleModal({ open: false });
    } catch (e) {
      console.error("Failed to save schedule", e);
      alert("저장 실패");
    }
  };

  const onNoDeadline = () => {
    if (isManualTodo) {
      setManualTodos(prev => {
        const next = prev.map(t => t.id === id ? { ...t, deadline: null } : t);
        void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
        return next;
      });
      setDeadlines(prev => {
        const next = { ...prev, [id.toString()]: null };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
    } else {
      setDeadlines(prev => {
        const next = { ...prev, [id.toString()]: null };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
    }
    // 달력 업데이트 이벤트 발생
    void emit('calendar-update');
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
                <label htmlFor="calendar-title">달력 제목 (짧게)</label>
                <input 
                  id="calendar-title" 
                  type="text" 
                  value={calendarTitle}
                  onChange={(e) => setCalendarTitle(e.target.value)}
                  placeholder="예: 과제 제출, 회의"
                  maxLength={20}
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius)',
                    fontSize: '14px',
                  }}
                />
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
