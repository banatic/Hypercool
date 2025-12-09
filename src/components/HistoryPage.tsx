import React, { useCallback, useRef, useEffect } from 'react';
import { Message, SearchResultItem } from '../types';
import { PageHeader } from './PageHeader';
import { AttachmentList } from './AttachmentList';
import { decodeEntities, formatDate, formatReceiveDate } from '../utils/dateUtils';

interface HistoryPageProps {
  totalMessageCount: number;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  historyIndex: number;
  setHistoryIndex: (index: number) => void;
  allMessages: Message[];
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
  const historyDragRef = useRef({ startX: 0, dragging: false });

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

  const historyOnMouseDown = useCallback((e: React.MouseEvent) => {
    historyDragRef.current.dragging = true;
    historyDragRef.current.startX = e.clientX;

    const onMouseMove = (e: MouseEvent) => {
      if (!historyDragRef.current.dragging) return;
      const dx = e.clientX - historyDragRef.current.startX;
      const threshold = 100;
      if (dx > threshold && historyIndex > 0) {
        setHistoryIndex(historyIndex - 1);
        historyDragRef.current.dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      } else if (dx < -threshold && historyIndex < allMessages.length - 1) {
        setHistoryIndex(historyIndex + 1);
        historyDragRef.current.dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
    };

    const onMouseUp = () => {
      historyDragRef.current.dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [historyIndex, allMessages.length, setHistoryIndex]);

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
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
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
          <div className="history-card-stack" onMouseDown={historyOnMouseDown}>
            {(() => {
              const renderWindow = 11; // 현재 아이템 기준 앞뒤로 5개씩
              const startIndex = Math.max(0, historyIndex - Math.floor(renderWindow / 2));
              const endIndex = Math.min(allMessages.length, startIndex + renderWindow);

              return allMessages.slice(startIndex, endIndex).map((msg, i) => {
                const idx = startIndex + i; // 원래 인덱스 복원
                const isCurrent = idx === historyIndex;
                const offset = idx - historyIndex;
                const classification = classified[msg.id];
                const deadline = deadlines[msg.id.toString()]; // deadlines keys are strings
                
                return (
                  <div 
                    key={msg.id} 
                    className={`history-card ${isCurrent ? 'current' : 'offset'}`}
                    style={{
                      transform: `translateX(${offset * 20}px) translateY(${Math.abs(offset) * 20}px) scale(${1 - Math.abs(offset) * 0.05})`,
                      zIndex: allMessages.length - Math.abs(offset),
                      opacity: Math.abs(offset) > 3 ? 0 : 1 - Math.abs(offset) * 0.15
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
                      <div className="history-card-content" dangerouslySetInnerHTML={{ __html: decodeEntities(msg.content) }} />
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
    return (
      <>
        <PageHeader title={`검색 결과 (${searchResults?.length || 0})`}>
          <div className="history-search">
            <input
              type="text"
              placeholder="발송자 또는 내용으로 검색..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
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
                {isLoadingSearch ? '검색 중...' : '검색 결과가 없습니다.'}
              </div>
            )}
          </div>
          <div className="history-results-pane">
            {isLoadingSearch && <div className="empty">검색 중...</div>}
            {!isLoadingSearch && searchResults && (
              <div className="results-list">
                {searchResults.map((item) => (
                  <div
                    key={item.id}
                    className={`result-item ${activeSearchMessage?.id === item.id ? 'active' : ''}`}
                    onClick={() => onSearchResultClick(item.id)}
                  >
                    <div className="result-sender">{item.sender}</div>
                    <div className="result-snippet">{item.snippet}</div>
                  </div>
                ))}
              </div>
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
