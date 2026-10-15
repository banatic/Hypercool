import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Paperclip, Smartphone } from 'lucide-react';
import { useData } from '../context/DataStore';
import { EventDetail } from '../components/EventDetail';
import { entriesForDay, entryKind, entryTitle, KIND_LABEL } from '../utils/entries';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/Layout';
import { isSchedule, type CalendarEntry } from '../types';
import { formatKoreanDate, formatListDate, parseDate, weekdayLabel, dDayLabel } from '../utils/dateUtils';
import { snippet } from '../utils/textUtils';
import './TodayPage.css';

const UPCOMING_DAYS = 7;
const RECENT_MESSAGES = 5;

export const TodayPage: React.FC = () => {
  const { user, todos, schedules, recentMessages, loading, error } = useData();
  const [openEntry, setOpenEntry] = useState<CalendarEntry | null>(null);
  const now = useMemo(() => new Date(), []);

  const todayEntries = useMemo(() => entriesForDay(schedules, todos, now), [schedules, todos, now]);

  const upcoming = useMemo(() => {
    const days: { date: Date; entries: CalendarEntry[] }[] = [];
    for (let i = 1; i <= UPCOMING_DAYS; i++) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      // 진행 중인 기간 일정은 시작일에만 보여 준다(매일 반복되면 소음이다).
      const entries = entriesForDay(schedules, todos, date).filter(e => {
        if (!isSchedule(e) || e.kind !== 'period') return true;
        const s = parseDate(e.startDate);
        return !!s && s.toDateString() === date.toDateString();
      });
      if (entries.length) days.push({ date, entries });
    }
    return days;
  }, [schedules, todos, now]);

  const hour = now.getHours();
  const greeting = hour < 5 ? '늦은 밤이에요' : hour < 12 ? '좋은 아침이에요' : hour < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
  const firstName = user?.displayName?.trim();

  return (
    <div className="page today">
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName} 선생님` : ''}`}
        description={formatKoreanDate(now)}
      >
        <Link to="/widget" className="tool-link">
          <Smartphone size={16} aria-hidden="true" />
          iOS 위젯
        </Link>
      </PageHeader>
      {error && <div className="state-error" role="alert">{error}</div>}

      <div className="today-grid">
        <section className="panel today-panel" aria-labelledby="today-h">
          <header className="today-panel-head">
            <h2 id="today-h">오늘의 일정</h2>
            <span className="today-panel-count">{!loading && todayEntries.length > 0 ? `${todayEntries.length}개` : ''}</span>
          </header>
          {loading ? (
            <SkeletonRows n={3} />
          ) : todayEntries.length === 0 ? (
            <div className="state-empty">
              <strong>오늘은 일정이 없습니다</strong>
            </div>
          ) : (
            <ul className="today-list">
              {todayEntries.map(entry => <EntryRow key={entry.id} entry={entry} onOpen={setOpenEntry} />)}
            </ul>
          )}
        </section>

        <section className="panel today-panel" aria-labelledby="upcoming-h">
          <header className="today-panel-head">
            <h2 id="upcoming-h">다가오는 {UPCOMING_DAYS}일</h2>
            <Link to="/calendar" className="today-more">달력 보기 <ArrowRight size={14} /></Link>
          </header>
          {loading ? (
            <SkeletonRows n={4} />
          ) : upcoming.length === 0 ? (
            <div className="state-empty">
              <strong>예정된 일정이 없습니다</strong>
            </div>
          ) : (
            <div className="upcoming">
              {upcoming.map(({ date, entries }) => (
                <div key={date.toDateString()} className="upcoming-day">
                  <div className="upcoming-date">
                    <span className="upcoming-daynum">{date.getDate()}</span>
                    <span className="upcoming-weekday">{weekdayLabel(date)}</span>
                    <span className="upcoming-dday">{dDayLabel(date, now)}</span>
                  </div>
                  <ul className="today-list">
                    {entries.map(entry => <EntryRow key={entry.id} entry={entry} onOpen={setOpenEntry} compact />)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel today-panel today-messages" aria-labelledby="messages-h">
          <header className="today-panel-head">
            <h2 id="messages-h">최근 메시지</h2>
            <Link to="/messages" className="today-more">전체 보기 <ArrowRight size={14} /></Link>
          </header>
          {loading ? (
            <SkeletonRows n={5} />
          ) : recentMessages.length === 0 ? (
            <div className="state-empty">
              <strong>메시지가 없습니다</strong>
            </div>
          ) : (
            <ul className="today-list">
              {recentMessages.slice(0, RECENT_MESSAGES).map(m => {
                const d = parseDate(m.receive_date);
                return (
                  <li key={m.id}>
                    <Link to={`/messages?id=${m.id}`} className="msg-row">
                      <span className="msg-row-top">
                        <span className="msg-row-sender">{m.sender}</span>
                        <span className="msg-row-date">{d ? formatListDate(d, now) : ''}</span>
                      </span>
                      <span className="msg-row-snippet">
                        {m.file_paths && m.file_paths.length > 0 && <Paperclip size={12} aria-label="첨부 있음" />}
                        <span className="msg-row-text">{snippet(m.content, 80) || '(내용 없음)'}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <Modal isOpen={!!openEntry} onClose={() => setOpenEntry(null)} title={openEntry ? entryTitle(openEntry) : undefined}>
        {openEntry && <EventDetail entry={openEntry} />}
      </Modal>
    </div>
  );
};

const EntryRow: React.FC<{ entry: CalendarEntry; onOpen: (e: CalendarEntry) => void; compact?: boolean }> = ({ entry, onOpen, compact }) => {
  const kind = entryKind(entry);
  const done = !isSchedule(entry) && entry.isCompleted;
  return (
    <li>
      <button type="button" className={`entry-row${done ? ' done' : ''}${compact ? ' compact' : ''}`} onClick={() => onOpen(entry)}>
        <span className={`agenda-mark ${kind}`} aria-hidden="true" />
        <span className="entry-title">{entryTitle(entry)}</span>
        <span className="entry-kind">{KIND_LABEL[kind]}{done ? ' · 완료' : ''}</span>
      </button>
    </li>
  );
};

const SkeletonRows: React.FC<{ n: number }> = ({ n }) => (
  <ul className="today-list" aria-busy="true">
    {Array.from({ length: n }, (_, i) => (
      <li key={i} className="entry-row" style={{ pointerEvents: 'none' }}>
        <span className="skeleton" style={{ width: `${55 + (i % 3) * 12}%` }}>&nbsp;</span>
      </li>
    ))}
  </ul>
);
