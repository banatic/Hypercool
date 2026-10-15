import React, { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { CalendarDays, Clock } from 'lucide-react';
import { db, auth } from '../firebase';
import { isSchedule, type CalendarEntry } from '../types';
import { parseDate, formatRange, formatKoreanDate, dDayLabel } from '../utils/dateUtils';
import { sanitizeHtml } from '../utils/sanitize';
import { entryKind, KIND_LABEL } from '../utils/entries';
import './EventDetail.css';

interface Fetched {
  entryId: string;
  html: string | null; // null = 아직 가져오는 중
}

/** 일정/할 일 상세 본문. 메시지에서 만든 일정은 본문이 비어 있으면 원본 메시지를 가져온다. */
export const EventDetail: React.FC<{ entry: CalendarEntry }> = ({ entry }) => {
  const needsFetch = !entry.content && !!entry.referenceId;
  const [fetched, setFetched] = useState<Fetched | null>(null);

  useEffect(() => {
    if (!needsFetch || !auth.currentUser) return;
    let cancelled = false;
    const entryId = entry.id;
    getDoc(doc(db, 'users', auth.currentUser.uid, 'messages', entry.referenceId!))
      .then(snap => {
        if (cancelled) return;
        setFetched({ entryId, html: snap.exists() ? (snap.data().content as string) : '<p>원본 메시지를 찾을 수 없습니다.</p>' });
      })
      .catch(e => {
        console.error('Error fetching message content:', e);
        if (!cancelled) setFetched({ entryId, html: '<p>내용을 불러오지 못했습니다.</p>' });
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, entry.id, entry.referenceId]);

  const kind = entryKind(entry);
  let when: string;
  let dday: string | null = null;
  if (isSchedule(entry)) {
    const s = parseDate(entry.startDate);
    const e = parseDate(entry.endDate) ?? s;
    when = s && e ? formatRange(s, e) : '날짜 없음';
    if (s && kind !== 'period') dday = dDayLabel(s);
  } else {
    const d = parseDate(entry.deadline);
    when = d ? formatKoreanDate(d) : '기한 없음';
    if (d) dday = dDayLabel(d);
  }

  const fetchedForThis = fetched?.entryId === entry.id ? fetched.html : null;
  const fetching = needsFetch && fetchedForThis === null;
  const html = entry.content || fetchedForThis;

  return (
    <div className="event-detail">
      <div className="event-meta">
        <span className={`chip ${kind}`}>
          <span className="chip-dot" />
          {KIND_LABEL[kind]}
        </span>
        <span className="event-when">
          {kind === 'period' ? <CalendarDays size={15} aria-hidden="true" /> : <Clock size={15} aria-hidden="true" />}
          {when}
        </span>
        {dday && <span className="chip">{dday}</span>}
      </div>

      {fetching ? (
        <div className="event-body-loading" aria-busy="true">
          <span className="skeleton" style={{ width: '90%' }}>&nbsp;</span>
          <span className="skeleton" style={{ width: '70%' }}>&nbsp;</span>
          <span className="skeleton" style={{ width: '80%' }}>&nbsp;</span>
        </div>
      ) : html ? (
        <div className="rich-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
      ) : (
        <p className="event-empty">추가 설명이 없습니다.</p>
      )}
    </div>
  );
};
