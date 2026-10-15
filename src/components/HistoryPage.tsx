import React, { useCallback, useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message, MessageMeta, SearchResultItem } from '../types';
import { PageHeader } from './PageHeader';
import { AttachmentList } from './AttachmentList';
import { MessageContent } from './MessageContent';
import { decodeEntities, formatDate, formatReceiveDate } from '../utils/dateUtils';
import { animateSpring, project, clamp, prefersReducedMotion, SpringHandle } from '../utils/spring';

// Performance logging helper
const logPerf = (label: string, startTime?: number) => {
    const now = performance.now();
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    if (startTime !== undefined) {
        console.log(`[PERF ${timestamp}] ${label}: ${(now - startTime).toFixed(1)}ms`);
    } else {
        console.log(`[PERF ${timestamp}] ${label}`);
    }
    return now;
};

// 검색어 부분을 <mark>로 강조해 렌더링
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HighlightedText: React.FC<{ text: string; terms: string[] }> = ({ text, terms }) => {
    const validTerms = terms.filter(t => t.length > 0);
    if (!text || validTerms.length === 0) return <>{text}</>;
    const pattern = new RegExp(`(${validTerms.map(escapeRegExp).join('|')})`, 'gi');
    // 캡처 그룹 split: 홀수 인덱스가 매칭된 부분
    const parts = text.split(pattern);
    return (
        <>
            {parts.map((part, i) =>
                i % 2 === 1 ? <mark key={i}>{part}</mark> : part
            )}
        </>
    );
};

// Memoized search result item to prevent re-renders
const SearchResultItemMemo = React.memo(({
    item,
    isActive,
    searchTerms,
    onClick
}: {
    item: SearchResultItem;
    isActive: boolean;
    searchTerms: string[];
    onClick: () => void;
}) => {
    // Format date for display (e.g., "12/16 08:43")
    const formatDate = (dateStr?: string | null) => {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr);
            const month = d.getMonth() + 1;
            const day = d.getDate();
            const hours = String(d.getHours()).padStart(2, '0');
            const mins = String(d.getMinutes()).padStart(2, '0');
            return `${month}/${day} ${hours}:${mins}`;
        } catch {
            return '';
        }
    };

    return (
        <div
            className={`result-item ${isActive ? 'active' : ''}`}
            onClick={onClick}
        >
            <div className="result-header">
                <div className="result-sender"><HighlightedText text={item.sender} terms={searchTerms} /></div>
                <div className="result-date">{formatDate(item.receive_date)}</div>
            </div>
            <div className="result-snippet"><HighlightedText text={item.snippet} terms={searchTerms} /></div>
        </div>
    );
}, (prevProps, nextProps) => {
    return prevProps.isActive === nextProps.isActive &&
           prevProps.item.id === nextProps.item.id &&
           prevProps.item.snippet === nextProps.item.snippet &&
           prevProps.searchTerms.join(' ') === nextProps.searchTerms.join(' ');
});

// Virtualized search results using @tanstack/react-virtual
const ITEM_HEIGHT = 100; // Must match .result-item CSS height

const VirtualizedSearchResults = React.memo(({
    searchResults,
    activeSearchMessage,
    searchTerms,
    onSearchResultClick
}: {
    searchResults: SearchResultItem[];
    activeSearchMessage: Message | null;
    searchTerms: string[];
    onSearchResultClick: (id: number) => void;
}) => {
    const parentRef = useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
        count: searchResults.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ITEM_HEIGHT,
        overscan: 3, // Render 3 extra items above/below viewport
    });

    return (
        <div
            ref={parentRef}
            className="results-list"
            style={{ height: 400, overflowY: 'auto' }}
        >
            <div
                style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                }}
            >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                    const item = searchResults[virtualItem.index];
                    return (
                        <div
                            key={item.id}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: `${virtualItem.size}px`,
                                transform: `translateY(${virtualItem.start}px)`,
                            }}
                        >
                            <SearchResultItemMemo
                                item={item}
                                isActive={activeSearchMessage?.id === item.id}
                                searchTerms={searchTerms}
                                onClick={() => {
                                    logPerf(`CLICK search result id=${item.id}`);
                                    onSearchResultClick(item.id);
                                }}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
});

interface HistoryPageProps {
  totalMessageCount: number;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  historyIndex: number;
  setHistoryIndex: (index: number) => void;
  allMessages: MessageMeta[];  // Now uses lightweight MessageMeta
  getFullMessage: (id: number) => Promise<Message | null>;
  loadUdbFile: (path?: string, offset?: number, searchTerm?: string) => Promise<void>;
  udbPath: string;
  isLoading?: boolean;
  classified?: Record<number, 'left' | 'right'>;
  deadlines: Record<string, string | null>;
  setScheduleModal?: (modal: { open: boolean; id?: number }) => void;
  searchResults: SearchResultItem[] | null;
  isLoadingSearch: boolean;
  activeSearchMessage: Message | null;
  isLoadingActiveSearch: boolean;
  onSearchResultClick: (id: number) => void;
  onHideToTray?: () => void;
  calendarTitles?: Record<string, string>;
}

export const HistoryPage: React.FC<HistoryPageProps> = ({
  totalMessageCount,
  searchTerm,
  setSearchTerm,
  historyIndex,
  setHistoryIndex,
  allMessages,
  getFullMessage,
  loadUdbFile,
  udbPath,
  isLoading = false,
  classified = {},
  deadlines,
  setScheduleModal,
  searchResults,
  isLoadingSearch,
  activeSearchMessage,
  isLoadingActiveSearch,
  onSearchResultClick,
}) => {
  const wheelLastProcessed = useRef(0);

  // 검색 입력은 로컬 상태로 두고 디바운스된 값만 부모로 올린다.
  // 키 입력마다 App 전체가 리렌더되는 것을 막고, 검색 뷰 전환도 디바운스된 searchTerm 기준으로 일어난다.
  const [searchInput, setSearchInput] = useState(searchTerm);
  useEffect(() => {
    const handler = setTimeout(() => {
      if (searchInput !== searchTerm) setSearchTerm(searchInput);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchInput, searchTerm, setSearchTerm]);

  // 하이라이트용 검색어 목록 (백엔드와 동일하게 공백 분리)
  const searchTerms = useMemo(
    () => searchTerm.trim().split(/\s+/).filter(Boolean),
    [searchTerm]
  );

  const handleHistoryWheel = useCallback((e: React.WheelEvent) => {
    if (isLoading) return;

    const now = Date.now();
    if (now - wheelLastProcessed.current < 100) { // 100ms 딜레이
      return;
    }

    let isActionTaken = false;

    // 휠을 아래로 내릴 때 (다음 메시지)
    if (e.deltaY > 0) {
      if (historyIndex < allMessages.length - 1) {
        setHistoryIndex(historyIndex + 1);
        isActionTaken = true;
      }
      
      // 로드된 메시지의 끝에 가까워지면 다음 페이지 로드
      const loadThreshold = 5; // 5개 남았을 때 미리 로드
      if (historyIndex >= allMessages.length - loadThreshold && allMessages.length < totalMessageCount) {
        loadUdbFile(udbPath, allMessages.length, '');
        isActionTaken = true; // 데이터 로드도 액션으로 간주
      }
    } 
    // 휠을 위로 올릴 때 (이전 메시지)
    else if (e.deltaY < 0 && historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      isActionTaken = true;
    }

    if (isActionTaken) {
      wheelLastProcessed.current = now;
    }
  }, [historyIndex, allMessages.length, totalMessageCount, isLoading, udbPath, loadUdbFile, searchTerm, setHistoryIndex]);

  // ── 히스토리 덱: 손가락 1:1 추적 + 속도 인계 + 모멘텀 페이징(§2·§5·§6) ──
  // 카드 transform 은 React style 이 아니라 여기서 직접 구동한다. 그래야
  // 드래그가 손가락에 1:1로 붙고, 릴리스 속도를 스프링에 그대로 넘길 수 있다(§3).
  const STEP = 20; // 오프셋 한 칸의 시각적 가로 간격(px)
  const ADVANCE = 120; // 한 장 넘기는 데 필요한 투영 거리(px)
  const stackRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const idxOfId = useRef<Map<number, number>>(new Map());
  const dragX = useRef(0);
  const deckSpring = useRef<SpringHandle | null>(null);
  const springing = useRef(false);
  const idxRef = useRef(historyIndex);
  useEffect(() => {
    idxRef.current = historyIndex;
  }, [historyIndex]);
  const deckDrag = useRef({ id: -1, startX: 0, active: false, decided: false, hist: [] as { t: number; x: number }[] });

  const layoutDeck = useCallback((withTransition: boolean) => {
    const idx = idxRef.current;
    const dx = dragX.current;
    cardEls.current.forEach((el, id) => {
      const ai = idxOfId.current.get(id);
      if (ai === undefined) return;
      const o = ai - idx;
      const ao = Math.abs(o);
      const scale = 1 - ao * 0.05;
      const opacity = ao > 3 ? 0 : 1 - ao * 0.15;
      const rot = o === 0 ? clamp(dx / 18, -14, 14) : 0;
      el.style.transition = withTransition
        ? 'transform 0.34s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.34s ease'
        : 'none';
      el.style.transform = `translateX(${o * STEP + dx}px) translateY(${ao * STEP}px) scale(${scale}) rotate(${rot}deg)`;
      el.style.opacity = String(opacity);
      el.style.zIndex = String(1000 - ao);
      el.classList.toggle('current', o === 0);
      el.classList.toggle('offset', o !== 0);
    });
  }, []);

  // 렌더/인덱스 변경 후 카드를 제자리로. 스프링이 도는 중엔 스프링이 주도하므로
  // 전환 없이(즉시) 위치만 맞춘다.
  useLayoutEffect(() => {
    layoutDeck(!springing.current);
  });

  useEffect(() => () => deckSpring.current?.stop(), []);

  const deckVelocity = (): number => {
    const h = deckDrag.current.hist;
    if (h.length < 2) return 0;
    const a = h[0];
    const b = h[h.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? ((b.x - a.x) / dt) * 1000 : 0;
  };

  // 끝에서의 점진적 저항(§9)
  const rubber = (x: number): number => {
    const c = 0.55;
    const dim = window.innerWidth || 1200;
    return (x * dim * c) / (dim + c * Math.abs(x));
  };

  const onDeckPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    deckSpring.current?.stop();
    springing.current = false;
    const d = deckDrag.current;
    d.id = e.pointerId;
    d.startX = e.clientX - dragX.current; // 잡은 위치 오프셋 존중(§2)
    d.active = true;
    d.decided = false;
    d.hist = [{ t: e.timeStamp, x: e.clientX }];
    stackRef.current?.setPointerCapture(e.pointerId);
  };

  const onDeckPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = deckDrag.current;
    if (!d.active || e.pointerId !== d.id) return;
    let x = e.clientX - d.startX;
    d.hist.push({ t: e.timeStamp, x: e.clientX });
    if (d.hist.length > 6) d.hist.shift();
    if (!d.decided) {
      if (Math.abs(x) < 8) return; // 히스테리시스(§10)
      d.decided = true;
      stackRef.current?.classList.add('dragging');
    }
    const idx = idxRef.current;
    const maxIdx = allMessages.length - 1;
    if ((idx <= 0 && x > 0) || (idx >= maxIdx && x < 0)) x = rubber(x);
    dragX.current = x;
    layoutDeck(false);
  };

  const onDeckPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = deckDrag.current;
    if (e.pointerId !== d.id) return;
    d.active = false;
    try {
      stackRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* 이미 해제됨 */
    }
    stackRef.current?.classList.remove('dragging');
    if (!d.decided) return;

    const vx = deckVelocity();
    const projected = dragX.current + project(vx); // 착지점 투영(§6)
    const rawSteps = Math.round(projected / ADVANCE);
    const idx = idxRef.current;
    const maxIdx = Math.max(0, allMessages.length - 1);
    const newIndex = clamp(idx - rawSteps, 0, maxIdx);
    const steps = idx - newIndex; // 실제 반영된 스텝

    // 끝에 가까워지면 다음 페이지 미리 로드
    if (newIndex >= allMessages.length - 5 && allMessages.length < totalMessageCount) {
      loadUdbFile(udbPath, allMessages.length, '');
    }

    // 재인덱스 후에도 화면 위치가 이어지도록 dragX 보정(연속성)
    dragX.current = dragX.current - steps * STEP;
    idxRef.current = newIndex;
    if (newIndex !== idx) setHistoryIndex(newIndex);

    if (prefersReducedMotion()) {
      dragX.current = 0;
      layoutDeck(false);
      return;
    }
    springing.current = true;
    deckSpring.current = animateSpring({
      from: dragX.current,
      to: 0,
      velocity: vx,
      onUpdate: (v) => {
        dragX.current = v;
        layoutDeck(false);
      },
      onComplete: () => {
        springing.current = false;
        dragX.current = 0;
        layoutDeck(true);
      },
    });
  };

  // 키보드 이벤트로 메시지 넘기기
  const handleHistoryKeyDown = useCallback((e: KeyboardEvent) => {
    if (isLoading) return;
    
    // 입력 필드에 포커스가 있으면 키보드 이벤트 무시
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    const now = Date.now();
    if (now - wheelLastProcessed.current < 100) {
      return;
    }

    let isActionTaken = false;

    // 우측/아래 키: 다음 메시지
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      if (historyIndex < allMessages.length - 1) {
        setHistoryIndex(historyIndex + 1);
        isActionTaken = true;
      }
      
      // 로드된 메시지의 끝에 가까워지면 다음 페이지 로드
      const loadThreshold = 5;
      if (historyIndex >= allMessages.length - loadThreshold && allMessages.length < totalMessageCount) {
        loadUdbFile(udbPath, allMessages.length, '');
        isActionTaken = true;
      }
    }
    // 좌측/위 키: 이전 메시지
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      isActionTaken = true;
    }

    if (isActionTaken) {
      wheelLastProcessed.current = now;
      e.preventDefault();
    }
  }, [historyIndex, allMessages.length, totalMessageCount, isLoading, udbPath, loadUdbFile, searchTerm, setHistoryIndex]);

  // 키보드 이벤트 리스너 등록
  useEffect(() => {
    window.addEventListener('keydown', handleHistoryKeyDown);
    return () => {
      window.removeEventListener('keydown', handleHistoryKeyDown);
    };
  }, [handleHistoryKeyDown]);

  const renderNormalHistory = () => (
    <>
      <PageHeader title={`전체 메시지 (${totalMessageCount})`}>
        <div className="history-search">
          <input
            type="text"
            placeholder="발송자 또는 내용으로 검색..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="history-nav">
          <button 
            onClick={() => setHistoryIndex(Math.max(0, historyIndex - 1))}
            disabled={historyIndex === 0}
            className="nav-btn"
          >
            ← 이전
          </button>
          <span className="history-counter">
            {historyIndex + 1} / {totalMessageCount}
          </span>
          <button 
            onClick={() => {
              const nextIndex = historyIndex + 1;
              if (nextIndex < allMessages.length) {
                setHistoryIndex(nextIndex);
              }
              // 다음 메시지가 로드되지 않았다면 로드
              if (nextIndex >= allMessages.length && allMessages.length < totalMessageCount && !isLoading) {
                loadUdbFile(udbPath, allMessages.length, '');
              }
            }}
            disabled={historyIndex >= totalMessageCount - 1}
            className="nav-btn"
          >
            다음 →
          </button>
        </div>
      </PageHeader>
      <div className="history-stage" onWheel={handleHistoryWheel}>
        {allMessages.length === 0 ? (
          <p className="empty">메시지가 없습니다.</p>
        ) : (
          <div
            className="history-card-stack"
            ref={stackRef}
            onPointerDown={onDeckPointerDown}
            onPointerMove={onDeckPointerMove}
            onPointerUp={onDeckPointerUp}
            onPointerCancel={onDeckPointerUp}
          >
            {(() => {
              const renderWindow = 11; // 현재 아이템 기준 앞뒤로 5개씩
              const startIndex = Math.max(0, historyIndex - Math.floor(renderWindow / 2));
              const endIndex = Math.min(allMessages.length, startIndex + renderWindow);

              // 카드 위치는 layoutDeck 이 직접 구동한다. 여기서는 id→절대인덱스만 기록.
              idxOfId.current.clear();

              return allMessages.slice(startIndex, endIndex).map((msg, i) => {
                const idx = startIndex + i; // 원래 인덱스 복원
                idxOfId.current.set(msg.id, idx);
                const classification = classified[msg.id];
                const deadline = deadlines[msg.id.toString()]; // deadlines keys are strings

                return (
                  <div
                    key={msg.id}
                    className="history-card"
                    ref={(el) => {
                      if (el) cardEls.current.set(msg.id, el);
                      else cardEls.current.delete(msg.id);
                    }}
                  >
                    <div className="history-card-inner">
                      <div className="history-card-header">
                        <span className="history-id">#{msg.id}</span>
                        <span className="history-sender">{msg.sender}</span>
                        {msg.receive_date && (
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: '8px' }}>
                            {formatReceiveDate(msg.receive_date)}
                          </span>
                        )}
                        {classification && (
                          <span className={`history-badge ${classification}`}>
                            {classification === 'left' ? '완료' : '해야할 일'}
                          </span>
                        )}
                        {deadline && (
                          <span className="history-deadline">
                            {formatDate(deadline)}
                          </span>
                        )}
                        {setScheduleModal && (
                          <button 
                            className="history-set-deadline-btn"
                            onClick={() => setScheduleModal({ open: true, id: msg.id })}
                          >
                            마감 설정
                          </button>
                        )}
                      </div>
                      <MessageContent className="history-card-content" message={msg} getFullMessage={getFullMessage} />
                      {msg.file_paths && msg.file_paths.length > 0 && (
                        <AttachmentList filePaths={msg.file_paths} />
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </>
  );

  const renderSearchResults = () => {
    const hasResults = !!searchResults && searchResults.length > 0;
    return (
      <>
        <PageHeader title={`검색 결과 (${searchResults?.length || 0})${isLoadingSearch ? ' · 검색 중…' : ''}`}>
          <div className="history-search">
            <input
              type="text"
              placeholder="발송자 또는 내용으로 검색..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </PageHeader>
        <div className="history-search-layout">
          <div className="history-main-pane">
            {isLoadingActiveSearch && <div className="empty">로딩 중...</div>}
            {!isLoadingActiveSearch && activeSearchMessage && (
              <div className="history-card current">
                <div className="history-card-inner">
                  <div className="history-card-header">
                    <span className="history-id">#{activeSearchMessage.id}</span>
                    <span className="history-sender">{activeSearchMessage.sender}</span>
                    {setScheduleModal && (
                      <button
                        className="history-set-deadline-btn"
                        onClick={() => setScheduleModal({ open: true, id: activeSearchMessage.id })}
                      >
                        마감 설정
                      </button>
                    )}
                  </div>
                  <div className="history-card-content" dangerouslySetInnerHTML={{ __html: decodeEntities(activeSearchMessage.content) }} />
                  {activeSearchMessage.file_paths && activeSearchMessage.file_paths.length > 0 && (
                    <AttachmentList filePaths={activeSearchMessage.file_paths} />
                  )}
                </div>
              </div>
            )}
            {!isLoadingActiveSearch && !activeSearchMessage && (
              <div className="empty">
                {hasResults
                  ? '오른쪽 목록에서 메시지를 선택하세요.'
                  : isLoadingSearch ? '검색 중...' : '검색 결과가 없습니다.'}
              </div>
            )}
          </div>
          <div className="history-results-pane" style={isLoadingSearch ? { opacity: 0.6 } : undefined}>
            {hasResults ? (
              // 새 검색이 진행 중이어도 이전 결과를 유지해 화면 깜빡임을 막는다
              <VirtualizedSearchResults
                searchResults={searchResults}
                activeSearchMessage={activeSearchMessage}
                searchTerms={searchTerms}
                onSearchResultClick={onSearchResultClick}
              />
            ) : (
              <div className="empty">{isLoadingSearch ? '검색 중...' : '검색 결과가 없습니다.'}</div>
            )}
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="history page-content">
      {searchTerm.trim() ? renderSearchResults() : renderNormalHistory()}
    </div>
  );
};
