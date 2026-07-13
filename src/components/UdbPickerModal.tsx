import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface UdbCandidate {
  path: string;
  name: string;
  size: number;
  folder: string;
}

interface UdbPickerModalProps {
  /** 후보에서 선택했거나 직접 고른 파일 경로를 확정할 때 호출 */
  onSelect: (path: string) => void;
  /** 직접 파일 선택 다이얼로그 (App 의 pickUdb) */
  onPickFile: () => Promise<void>;
  /** 모달 닫기 (선택 없이) */
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export const UdbPickerModal: React.FC<UdbPickerModalProps> = ({ onSelect, onPickFile, onClose }) => {
  const [candidates, setCandidates] = useState<UdbCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await invoke<UdbCandidate[]>('list_coolmessenger_udbs');
        if (!cancelled) {
          setCandidates(list);
          // 가장 유력한(가장 큰) 후보를 기본 선택
          if (list.length > 0) setSelected(list[0].path);
        }
      } catch (e) {
        console.warn('UDB 후보 탐색 실패', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = useCallback(() => {
    if (selected) onSelect(selected);
  }, [selected, onSelect]);

  return (
    <div className="schedule-modal-overlay" onClick={onClose}>
      <div
        className="schedule-modal udb-picker-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '560px', width: '90%' }}
      >
        <h2 style={{ marginTop: 0, marginBottom: '8px', fontSize: '20px', fontWeight: 600 }}>
          UDB 파일 선택
        </h2>
        <p style={{ marginTop: 0, marginBottom: '16px', fontSize: '14px', color: 'var(--text-secondary)' }}>
          쿨메신저 폴더에서 찾은 메시지 데이터베이스(.udb) 입니다. 사용할 파일을 선택하세요.
        </p>

        {loading ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
            쿨메신저 폴더를 검색하는 중...
          </div>
        ) : candidates.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
            쿨메신저 폴더에서 .udb 파일을 찾지 못했습니다.
            <br />
            아래 버튼으로 직접 선택해주세요.
          </div>
        ) : (
          <div className="udb-candidate-list">
            {candidates.map((c) => (
              <button
                key={c.path}
                type="button"
                className={`udb-candidate ${selected === c.path ? 'active' : ''}`}
                onClick={() => setSelected(c.path)}
              >
                <div className="udb-candidate-main">
                  <span className="udb-candidate-name">{c.name}</span>
                  <span className="udb-candidate-size">{formatSize(c.size)}</span>
                </div>
                <div className="udb-candidate-path">{c.folder ? `${c.folder} 폴더` : ''} · {c.path}</div>
              </button>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: '20px' }}>
          <button type="button" onClick={confirm} disabled={!selected}>
            선택한 파일 사용
          </button>
          <button
            type="button"
            onClick={onPickFile}
            style={{ background: 'var(--bg-light)', color: 'var(--text)' }}
          >
            다른 파일 직접 선택
          </button>
        </div>
      </div>
    </div>
  );
};
