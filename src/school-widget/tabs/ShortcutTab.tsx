import { KeyboardEvent, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { Shortcut } from '../types';

interface Props {
  shortcuts: Shortcut[];
  onAdd: (shortcut: Shortcut) => void;
  onDelete: (id: string) => void;
  onUpdate: (shortcut: Shortcut) => void;
}

const normalizeUrl = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const getHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const faviconUrl = (url: string) => {
  const host = getHost(url);
  if (!host) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
};

export default function ShortcutTab({ shortcuts, onAdd, onDelete, onUpdate }: Props) {
  const [editing, setEditing] = useState<Shortcut | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [error, setError] = useState('');

  const openForm = (target: Shortcut | null) => {
    if (target) {
      setEditing(target);
      setDraftName(target.name);
      setDraftUrl(target.url);
    } else {
      setEditing(null);
      setDraftName('');
      setDraftUrl('');
    }
    setAdding(true);
    setError('');
  };

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
    setDraftName('');
    setDraftUrl('');
    setError('');
  };

  const handleSave = () => {
    const url = normalizeUrl(draftUrl);
    if (!url) { setError('URL을 입력하세요.'); return; }
    if (!getHost(url)) { setError('올바른 URL이 아닙니다.'); return; }
    const name = draftName.trim() || getHost(url);
    if (editing) {
      onUpdate({ ...editing, url, name });
    } else {
      onAdd({
        id: 'sc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        url, name,
      });
    }
    closeForm();
  };

  const handleOpen = async (sc: Shortcut) => {
    try { await shellOpen(sc.url); } catch (e) { console.error('링크 열기 실패:', e); }
  };

  const handleFormKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSave();
    else if (e.key === 'Escape') closeForm();
  };

  return (
    <div className="shortcut-container">
      <div className="shortcut-grid">
        {shortcuts.map(sc => (
          <div key={sc.id} className="shortcut-tile-wrap">
            <button
              className="shortcut-tile"
              onClick={() => handleOpen(sc)}
              onContextMenu={(e) => { e.preventDefault(); openForm(sc); }}
              title={sc.url}
            >
              <div className="shortcut-icon">
                {faviconUrl(sc.url) ? (
                  <img
                    src={faviconUrl(sc.url)}
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : null}
                <span className="shortcut-icon-fallback">
                  {(sc.name[0] || '?').toUpperCase()}
                </span>
              </div>
              <div className="shortcut-label">{sc.name}</div>
            </button>
            <button
              className="shortcut-delete"
              onClick={(e) => { e.stopPropagation(); onDelete(sc.id); }}
              title="삭제"
              aria-label="삭제"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        ))}

        <button className="shortcut-tile shortcut-add-tile" onClick={() => openForm(null)}>
          <div className="shortcut-icon shortcut-add-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </div>
          <div className="shortcut-label">추가</div>
        </button>
      </div>

      {shortcuts.length === 0 && !adding && (
        <div className="shortcut-empty">+ 버튼으로 자주 가는 페이지를 추가해보세요.</div>
      )}

      {adding && (
        <div className="shortcut-modal-backdrop" onClick={closeForm}>
          <div className="shortcut-modal" onClick={(e) => e.stopPropagation()}>
            <div className="shortcut-modal-title">
              {editing ? '바로가기 편집' : '바로가기 추가'}
            </div>
            <input
              type="text"
              className="shortcut-input"
              placeholder="이름 (선택)"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={handleFormKey}
              autoFocus
            />
            <input
              type="text"
              className="shortcut-input"
              placeholder="https://example.com"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              onKeyDown={handleFormKey}
            />
            {error && <div className="shortcut-error">{error}</div>}
            <div className="shortcut-modal-actions">
              <button className="shortcut-btn-cancel" onClick={closeForm}>취소</button>
              <button className="shortcut-btn-save" onClick={handleSave}>
                {editing ? '저장' : '추가'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
