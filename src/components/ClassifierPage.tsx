import React from 'react';
import { MessageMeta } from '../types';
import { PageHeader } from './PageHeader';
import { AttachmentList } from './AttachmentList';
import { SwipeCard } from './SwipeCard';
import { formatReceiveDate } from '../utils/dateUtils';
import { Message } from '../types';
import { MessageContent } from './MessageContent';

interface ClassifierPageProps {
  isLoading: boolean;
  statusText: string;
  visibleMessages: MessageMeta[];  // Lightweight metadata only
  getFullMessage: (id: number) => Promise<Message | null>;
  classify: (id: number, direction: 'left' | 'right') => void;
  loadUdbFile: (path?: string, offset?: number, searchTerm?: string) => Promise<void>;
  udbPath: string;
  pickUdb: () => Promise<void>;
  completeAllPending: () => void;
  onHideToTray?: () => void;
  deadlines?: Record<string, string | null>;
  calendarTitles?: Record<string, string>;
  isSyncing?: boolean;
  syncProgress?: { current: number; total: number } | null;
  syncError?: string | null;
  onSync?: () => Promise<void>;
}

export const ClassifierPage: React.FC<ClassifierPageProps> = ({
  isLoading,
  statusText,
  visibleMessages,
  getFullMessage,
  classify,
  loadUdbFile,
  udbPath,
  pickUdb,
  completeAllPending,
  isSyncing,
  syncProgress,
}) => {
  return (
    <div className="classifier page-content">
      <PageHeader title="메시지 분류">
        <div className="header-actions">
          <span className="status">{statusText}</span>
          <button 
            onClick={() => { loadUdbFile(udbPath, 0); }} 
            disabled={isLoading} 
            className="refresh-btn" 
            title="새로고침"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6"></path>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
            새로고침
          </button>
          <button className="complete-all-btn" onClick={completeAllPending} disabled={visibleMessages.length === 0}>
            전부 완료 처리
          </button>
        </div>
      </PageHeader>
      <div className="classifier-stage">
        {visibleMessages.length === 0 && (
          <div className="empty">
            {udbPath ? (
              <>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                  <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                </svg>
                <span>분류할 메시지가 없습니다.</span>
              </>
            ) : (
              <div className="no-udb">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <p>UDB 파일을 선택해주세요.</p>
                <button onClick={pickUdb}>파일 선택</button>
              </div>
            )}
          </div>
        )}
        {visibleMessages.map((msg, idx) => {
          const inner = (
            <div className="card-inner">
              <div className="card-sender">
                {msg.sender}
                {msg.receive_date && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginLeft: '8px' }}>
                    {formatReceiveDate(msg.receive_date)}
                  </span>
                )}
              </div>
              <MessageContent className="card-content" message={msg} getFullMessage={getFullMessage} />
              {msg.file_paths && msg.file_paths.length > 0 && (
                <AttachmentList filePaths={msg.file_paths} />
              )}
              <div className="card-actions">
                <button className="left" onClick={() => classify(msg.id, 'left')}>◀ 완료된 일</button>
                <button className="right" onClick={() => classify(msg.id, 'right')}>해야할 일 ▶</button>
              </div>
            </div>
          );
          // 최상단 카드만 스와이프 상호작용(§2·§3), 뒷장은 정적으로 쌓아둔다.
          return idx === 0 ? (
            <SwipeCard key={msg.id} className="card top" onSwipe={(dir) => classify(msg.id, dir)}>
              {inner}
            </SwipeCard>
          ) : (
            <div key={msg.id} className="card back">{inner}</div>
          );
        }).reverse() /* Render back card first */}
      </div>
      {/* Sync Status Overlay or Indicator if needed */}
      {isSyncing && (
        <div className="sync-indicator">
          동기화 중... {syncProgress ? `${syncProgress.current}/${syncProgress.total}` : ''}
        </div>
      )}
    </div>
  );
};
