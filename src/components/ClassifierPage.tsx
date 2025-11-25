import React from 'react';
import { Message } from '../types';
import { PageHeader } from './PageHeader';

interface ClassifierPageProps {
  isLoading: boolean;
  statusText: string;
  unclassifiedCount: number;
  visibleMessages: Message[];
  onMouseDown: (id: number) => (e: React.MouseEvent<HTMLDivElement>) => void;
  classify: (id: number, direction: 'left' | 'right') => void;
  loadUdbFile: (path?: string, offset?: number, searchTerm?: string) => Promise<void>;
  udbPath: string;
  completeAllPending: () => void;
  decodeEntities: (html: string) => string;
  formatReceiveDate: (receiveDate: string | null | undefined) => string | null;
}

export const ClassifierPage: React.FC<ClassifierPageProps> = ({
  isLoading,
  statusText,
  unclassifiedCount,
  visibleMessages,
  onMouseDown,
  classify,
  loadUdbFile,
  udbPath,
  completeAllPending,
  decodeEntities,
  formatReceiveDate,
}) => {
  return (
    <div className="classifier page-content">
      <PageHeader title="메시지 분류">
        <button onClick={() => { loadUdbFile(udbPath, 0); }} disabled={isLoading} className="load-btn small">
          {isLoading ? '로딩 중...' : '메시지 다시 로드'}
        </button>
        <span className="status">{statusText}</span>
        <button className="complete-all-btn" onClick={completeAllPending} disabled={unclassifiedCount === 0}>전부 완료 처리</button>
      </PageHeader>
      <div className="classifier-stage">
        {visibleMessages.length === 0 && <div className="empty">분류할 메시지가 없습니다.</div>}
        {visibleMessages.map((msg, idx) => (
          <div key={msg.id} className={`card ${idx === 0 ? 'top' : 'back'}`} onMouseDown={onMouseDown(msg.id)}>
            <div className="card-inner">
              <div className="card-sender">
                {msg.sender}
                {msg.receive_date && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginLeft: '8px' }}>
                    {formatReceiveDate(msg.receive_date)}
                  </span>
                )}
              </div>
              <div className="card-content" dangerouslySetInnerHTML={{ __html: decodeEntities(msg.content) }} />
              <div className="card-actions">
                <button className="left" onClick={() => classify(msg.id, 'left')}>◀ 완료된 일</button>
                <button className="right" onClick={() => classify(msg.id, 'right')}>해야할 일 ▶</button>
              </div>
            </div>
          </div>
        )).reverse() /* Render back card first */}
      </div>
    </div>
  );
};
