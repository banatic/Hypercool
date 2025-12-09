import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Message } from '../types';
import { ScheduleService } from '../services/ScheduleService';
import { ScheduleItem } from '../types/schedule';
import { parseDateFromText, decodeEntities } from '../utils/dateUtils';

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  scheduleId?: number | string;
  onSave: () => void;
  udbPath?: string;
  allMessages?: Message[];
  schedules?: ScheduleItem[];
}

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  isOpen,
  onClose,
  scheduleId,
  onSave,
  udbPath,
  allMessages = [],
  schedules = [],
}) => {
  if (!isOpen || scheduleId === undefined) return null;

  const id = scheduleId;
  
  const existingSchedule = schedules.find(s => s.id === id || (s.type === 'message_task' && s.referenceId === id.toString()));
  const isMessageTask = typeof id === 'number' || (existingSchedule?.type === 'message_task');

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

  // Initialize form
  useEffect(() => {
    if (existingSchedule) {
      setCalendarTitle(existingSchedule.title);
      if (existingSchedule.startDate) {
        const d = new Date(existingSchedule.startDate);
        setDateVal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
        setTimeVal(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
      } else {
        setDateVal(defaultDate);
        setTimeVal(defaultTime);
      }
    } else {
      // New item (likely message task being classified for first time)
      setCalendarTitle('');
      setDateVal(defaultDate);
      setTimeVal(defaultTime);
    }

    // If it's a message task, load the message content
    if (isMessageTask) {
      const msgId = typeof id === 'number' ? id : (existingSchedule?.referenceId ? parseInt(existingSchedule.referenceId) : null);
      if (msgId) {
        const found = allMessages.find(m => m.id === msgId);
        if (found) {
          setModalMsg(found);
        } else if (udbPath) {
          setIsLoadingModalMsg(true);
          invoke<Message>('get_message_by_id', { dbPath: udbPath, id: msgId })
            .then(msg => setModalMsg(msg))
            .catch(e => console.error("Failed to load message", e))
            .finally(() => setIsLoadingModalMsg(false));
        }
      }
    }
  }, [id, existingSchedule, isMessageTask, allMessages, udbPath, defaultDate, defaultTime]);

  // Parse date from message content
  useEffect(() => {
    if (modalMsg && !existingSchedule?.startDate) {
      // Only parse if no existing date set
      const textContent = modalMsg.content.replace(/<[^>]*>/g, '');
      let baseDate: Date | undefined = undefined;
      if (modalMsg.receive_date) {
        try { baseDate = new Date(modalMsg.receive_date); } catch {}
      }
      
      const parsed = parseDateFromText(textContent, baseDate);
      setParsedDateInfo(parsed);
      
      if (parsed.date && (!dateVal || dateVal === defaultDate)) {
        setDateVal(parsed.date);
      }
      if (parsed.time && (!timeVal || timeVal === defaultTime)) {
        setTimeVal(parsed.time);
      }
    }
  }, [modalMsg, existingSchedule, dateVal, timeVal, defaultDate, defaultTime]);

  const handleSave = async () => {
    if (!dateVal || !timeVal) {
      // alert('날짜와 시간을 모두 입력해주세요.'); // Removed
      return;
    }

    const dateStr = `${dateVal}T${timeVal}:00`;
    const dateObj = new Date(dateStr);

    if (isNaN(dateObj.getTime())) {
      // alert('유효하지 않은 날짜 형식입니다.'); // Removed
      return;
    }

    const iso = dateObj.toISOString();
    const title = calendarTitle.trim();

    try {
      if (existingSchedule) {
        await ScheduleService.updateScheduleItem({
          ...existingSchedule,
          title: title || existingSchedule.title,
          startDate: iso,
          endDate: iso,
          updatedAt: new Date().toISOString()
        });
      } else if (isMessageTask && typeof id === 'number') {
        // Create new message task
        await ScheduleService.convertMessageToSchedule(
          id,
          dateObj,
          title || "메시지 일정",
          modalMsg?.content
        );
      }
      
      onSave();
      onClose();
    } catch (e) {
      console.error("Failed to save schedule", e);
      // alert("저장 실패"); // Removed
    }
  };

  const handleNoDeadline = async () => {
    try {
      if (existingSchedule) {
        await ScheduleService.updateScheduleItem({
          ...existingSchedule,
          startDate: undefined, // undefined will be serialized as null if we handle it right, or we need explicit null?
          // ScheduleItem struct has Option<String>.
          // TS type should allow null/undefined.
          endDate: undefined,
          updatedAt: new Date().toISOString()
        } as any); 
      }
      onSave();
      onClose();
    } catch (e) {
      console.error("Failed to update", e);
    }
  };

  return (
    <div className="schedule-modal-overlay" onClick={onClose}>
      <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-inner">
          <div className="schedule-preview">
            {isLoadingModalMsg ? (
              <div>로딩 중...</div>
            ) : modalMsg ? (
              <div dangerouslySetInnerHTML={{ __html: decodeEntities(modalMsg.content) }} />
            ) : existingSchedule?.content ? (
              <div dangerouslySetInnerHTML={{ __html: decodeEntities(existingSchedule.content) }} />
            ) : (
              <div>내용을 불러올 수 없습니다.</div>
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
              value={dateVal}
              onChange={(e) => setDateVal(e.target.value)} 
            />
            <label htmlFor="deadline-time">시간</label>
            <input 
              id="deadline-time" 
              type="time" 
              value={timeVal}
              onChange={(e) => setTimeVal(e.target.value)} 
            />
            <div className="row">
              <button onClick={handleSave}>저장</button>
              <button onClick={handleNoDeadline}>완료 시간 없음</button>
              <button onClick={onClose}>취소</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
