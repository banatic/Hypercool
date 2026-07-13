import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './SearchModal.css';
import { SearchResultItem } from './types';
import { prettifyAccelerator } from './utils/hotkey';

// 캐시 검색 DB(search_db::get_cached_message)의 전체 메시지
interface CachedMessage {
  id: number;
  sender: string;
  content: string;
  content_preview: string;
  receive_date?: string | null;
  file_paths: string[];
}

// message-viewer.html 과 동일: 엔티티 인코딩된 본문을 실제 HTML 로 되돌림
function decodeEntities(html: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = html;
  return textarea.value;
}

function formatDate(d?: string | null): string {
  if (!d) return '';
  return d.length > 16 ? d.slice(0, 16) : d;
}

// 검색어(공백 분리)와 일치하는 부분을 <mark> 로 감싼다 (대소문자 무시).
// split 의 캡처 그룹 덕분에 홀수 인덱스가 매칭 조각이 된다.
function highlight(text: string, terms: string[]): React.ReactNode {
  if (!text || terms.length === 0) return text;
  const escaped = terms
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return text;
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="hl">{part}</mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );
}

const MagnifierIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

function SearchModal() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [active, setActive] = useState<CachedMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [hotkeyLabel, setHotkeyLabel] = useState('Ctrl + Shift + Space');

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchGenRef = useRef(0);   // stale 검색 응답 가드
  const previewGenRef = useRef(0);  // stale 미리보기 응답 가드
  const openedAtRef = useRef(0);    // blur 조기 hide 방지용 타임스탬프

  // ── 디바운스 검색 (캐시 FTS) ────────────────────────────────
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      searchGenRef.current++;
      setResults([]);
      setActive(null);
      setSelectedIndex(0);
      setLoading(false);
      return;
    }
    const gen = ++searchGenRef.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await invoke<SearchResultItem[]>('search_messages_fts', { query: term, limit: 50 });
        if (gen !== searchGenRef.current) return; // 더 최신 검색이 시작됨
        setResults(res);
        setSelectedIndex(0);
      } catch (e) {
        if (gen === searchGenRef.current) setResults([]);
        console.error('검색 실패', e);
      } finally {
        if (gen === searchGenRef.current) setLoading(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  // ── 선택 항목 미리보기 로드 ─────────────────────────────────
  useEffect(() => {
    const item = results[selectedIndex];
    if (!item) {
      setActive(null);
      return;
    }
    const gen = ++previewGenRef.current;
    (async () => {
      try {
        const msg = await invoke<CachedMessage | null>('get_cached_message', { messageId: item.id });
        if (gen !== previewGenRef.current) return;
        setActive(msg);
      } catch (e) {
        if (gen === previewGenRef.current) setActive(null);
        console.error('미리보기 로드 실패', e);
      }
    })();
  }, [results, selectedIndex]);

  // 선택 항목을 리스트 뷰에 보이게 스크롤
  useEffect(() => {
    const el = listRef.current?.querySelector('.result-item.selected') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const closeModal = useCallback(() => {
    invoke('hide_search_modal').catch(() => {});
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
  }, [results.length, closeModal]);

  // ── 열림 이벤트 / 포커스 / blur-to-dismiss ──────────────────
  useEffect(() => {
    const win = getCurrentWindow();

    const unlistenOpen = listen('search-modal-open', () => {
      openedAtRef.current = Date.now();
      setQuery('');
      searchGenRef.current++;
      setResults([]);
      setActive(null);
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    });

    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        // 방금 연 직후의 포커스 미정착(레이스)으로 인한 조기 hide 방지
        if (Date.now() - openedAtRef.current < 250) return;
        closeModal();
      }
    });

    invoke<string>('get_search_hotkey')
      .then((a) => setHotkeyLabel(prettifyAccelerator(a)))
      .catch(() => {});

    requestAnimationFrame(() => inputRef.current?.focus());

    return () => {
      unlistenOpen.then((f) => f());
      unlistenFocus.then((f) => f());
    };
  }, [closeModal]);

  const term = query.trim();
  const terms = term ? term.split(/\s+/) : [];

  return (
    <div className="search-modal-container">
      <div className="search-bar" data-tauri-drag-region>
        <MagnifierIcon className="search-icon" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="메시지 검색..."
          spellCheck={false}
          autoComplete="off"
        />
        {loading && <div className="spinner" />}
      </div>

      <div className="search-body">
        {results.length > 0 ? (
          <>
            <div className="results-list" ref={listRef}>
              {results.map((r, i) => (
                <div
                  key={r.id}
                  className={`result-item${i === selectedIndex ? ' selected' : ''}`}
                  onClick={() => setSelectedIndex(i)}
                >
                  <div className="ri-top">
                    <span className="ri-sender">{highlight(r.sender || '(발신자 없음)', terms)}</span>
                    <span className="ri-date">{formatDate(r.receive_date)}</span>
                  </div>
                  <div className="ri-snippet">{highlight(r.snippet, terms)}</div>
                </div>
              ))}
            </div>

            <div className="preview-panel">
              {active ? (
                <>
                  <div className="preview-header">
                    <div className="ph-sender">{active.sender || '(발신자 없음)'}</div>
                    <div className="ph-date">{formatDate(active.receive_date)}</div>
                  </div>
                  <div
                    className="preview-content"
                    dangerouslySetInnerHTML={{ __html: decodeEntities(active.content) }}
                  />
                </>
              ) : (
                <div className="sm-empty">
                  <span className="sm-empty-hint">불러오는 중...</span>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="sm-empty">
            <MagnifierIcon className="sm-empty-icon" />
            <div className="sm-empty-title">
              {term ? (loading ? '검색 중...' : '검색 결과가 없습니다') : '메시지 검색'}
            </div>
            {!term && (
              <div className="sm-empty-hint">
                <kbd>{hotkeyLabel}</kbd> 로 언제든 열 수 있어요
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// HMR-safe: 기존 root 재사용 (school-widget.tsx 와 동일 패턴)
const rootEl = document.getElementById('root')!;
const root = (rootEl as any).__viteReactRoot ?? ReactDOM.createRoot(rootEl);
(rootEl as any).__viteReactRoot = root;
root.render(
  <React.StrictMode>
    <SearchModal />
  </React.StrictMode>
);
