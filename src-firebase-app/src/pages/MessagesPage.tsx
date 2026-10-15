import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, Search, Paperclip, Inbox } from 'lucide-react';
import { useMessages } from '../hooks/useMessages';
import { PageHeader } from '../components/Layout';
import type { Message } from '../types';
import { parseDate, formatListDate, formatKoreanDateTime } from '../utils/dateUtils';
import { snippet, stripHtml, matchesQuery, fileName } from '../utils/textUtils';
import { sanitizeHtml } from '../utils/sanitize';
import './MessagesPage.css';

export const MessagesPage: React.FC = () => {
  const { messages, loading, loadingMore, hasMore, error, loadMoreMessages } = useMessages();
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryText, setQueryText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  const selectedId = searchParams.get('id') ? Number(searchParams.get('id')) : null;

  const select = useCallback((id: number | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (id === null) next.delete('id');
      else next.set('id', String(id));
      return next;
    }, { replace: selectedId !== null });
  }, [setSearchParams, selectedId]);

  const filtered = useMemo(() => {
    if (!queryText.trim()) return messages;
    return messages.filter(m => matchesQuery(`${m.sender} ${stripHtml(m.content)}`, queryText));
  }, [messages, queryText]);

  const selected = useMemo(() => messages.find(m => m.id === selectedId) ?? null, [messages, selectedId]);

  // 데스크톱에서는 첫 메시지를 자동 선택해 빈 화면을 피한다(모바일은 목록이 먼저).
  useEffect(() => {
    if (loading || selectedId !== null || filtered.length === 0) return;
    if (window.matchMedia('(min-width: 900px)').matches) select(filtered[0].id);
  }, [loading, selectedId, filtered, select]);

  // 상세가 바뀌면 본문 스크롤을 맨 위로
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  // 위/아래 방향키로 목록 이동
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (filtered.length === 0) return;
      e.preventDefault();
      const idx = filtered.findIndex(m => m.id === selectedId);
      const nextIdx = e.key === 'ArrowDown' ? Math.min(filtered.length - 1, idx + 1) : Math.max(0, idx - 1);
      select(filtered[nextIdx].id);
      if (e.key === 'ArrowDown' && nextIdx === filtered.length - 1 && hasMore && !loadingMore) loadMoreMessages();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, selectedId, select, hasMore, loadingMore, loadMoreMessages]);

  // 목록 끝에 닿으면 자동으로 더 불러오기
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !loadingMore) loadMoreMessages();
    }, { root: listRef.current, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, loadMoreMessages]);

  const now = new Date();

  return (
    <div className={`page messages${selected ? ' has-selection' : ''}`}>
      <PageHeader title="메시지">
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={queryText}
            onChange={e => setQueryText(e.target.value)}
            placeholder="보낸 사람, 내용 검색"
            aria-label="불러온 메시지 검색"
          />
        </label>
      </PageHeader>

      {error && <div className="state-error" role="alert">{error}</div>}

      <div className="msg-layout panel">
        <div className="msg-list" ref={listRef} role="listbox" aria-label="메시지 목록">
          {loading ? (
            Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="msg-item" aria-busy="true">
                <span className="skeleton" style={{ width: '40%' }}>&nbsp;</span>
                <span className="skeleton" style={{ width: '85%', marginTop: 6 }}>&nbsp;</span>
              </div>
            ))
          ) : filtered.length === 0 ? (
            <div className="state-empty">
              <Inbox size={28} strokeWidth={1.5} aria-hidden="true" />
              <strong>{queryText ? '검색 결과가 없습니다' : '메시지가 없습니다'}</strong>
            </div>
          ) : (
            filtered.map(m => <MessageItem key={m.id} message={m} active={m.id === selectedId} now={now} onSelect={() => select(m.id)} />)
          )}

          {!loading && filtered.length > 0 && (
            <div ref={sentinelRef} className="msg-list-foot">
              {loadingMore ? '불러오는 중…' : hasMore ? (
                <button type="button" className="msg-load-more" onClick={loadMoreMessages}>더 불러오기</button>
              ) : '마지막 메시지입니다'}
            </div>
          )}
        </div>

        <article className="msg-detail" ref={detailRef} aria-live="polite">
          {selected ? (
            <MessageDetail message={selected} onBack={() => select(null)} />
          ) : (
            <div className="msg-detail-empty">
              <strong>메시지를 선택하세요</strong>
            </div>
          )}
        </article>
      </div>
    </div>
  );
};

const MessageItem: React.FC<{ message: Message; active: boolean; now: Date; onSelect: () => void }> = ({ message, active, now, onSelect }) => {
  const d = parseDate(message.receive_date);
  const hasFiles = !!message.file_paths?.length;
  return (
    <button type="button" role="option" aria-selected={active} className={`msg-item${active ? ' active' : ''}`} onClick={onSelect}>
      <span className="msg-item-top">
        <span className="msg-item-sender">{message.sender || '(보낸 사람 없음)'}</span>
        <span className="msg-item-date">{d ? formatListDate(d, now) : ''}</span>
      </span>
      <span className="msg-item-snippet">
        {hasFiles && <Paperclip size={12} aria-label="첨부 있음" />}
        <span className="msg-item-text">{snippet(message.content, 100) || '(내용 없음)'}</span>
      </span>
    </button>
  );
};

const MessageDetail: React.FC<{ message: Message; onBack: () => void }> = ({ message, onBack }) => {
  const d = parseDate(message.receive_date);
  const files = message.file_paths ?? [];
  return (
    <>
      <header className="msg-detail-head">
        <button type="button" className="msg-back" onClick={onBack} aria-label="목록으로">
          <ChevronLeft size={20} />
        </button>
        <div className="msg-detail-meta">
          <h2 className="msg-detail-sender">{message.sender || '(보낸 사람 없음)'}</h2>
          <div className="msg-detail-date">{d ? formatKoreanDateTime(d, { year: true }) : message.receive_date || ''}</div>
        </div>
      </header>

      {files.length > 0 && (
        <ul className="msg-files" aria-label="첨부파일">
          {files.map((p, i) => (
            <li key={`${p}-${i}`} className="msg-file" title={p}>
              <Paperclip size={13} aria-hidden="true" />
              <span>{fileName(p)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="msg-detail-body rich-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(message.content) }} />

    </>
  );
};
