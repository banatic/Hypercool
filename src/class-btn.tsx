import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import './class-btn.css';

const win = getCurrentWebviewWindow();
const LABEL = win.label;

const ROW_H = 27;
const ROW_GAP = 2;

interface RecipientStatus {
  name: string;
  subject: string | null;
  room: string | null;
}

interface ClassStatusResult {
  is_broadcast: boolean;
  in_class_period: boolean;
  current_period: number | null;
  recipients: RecipientStatus[];
}

type StatusKind = 'neutral' | 'busy' | 'free';

interface Row { text: string; kind: StatusKind; }

function getRows(s: ClassStatusResult): Row[] {
  if (s.is_broadcast) return [{ text: '방송', kind: 'neutral' }];

  if (!s.in_class_period) {
    if (s.recipients.length === 0) return [{ text: '쉬는시간', kind: 'neutral' }];
    return s.recipients.map(r => ({ text: r.name, kind: 'neutral' as StatusKind }));
  }

  if (s.recipients.length === 0) return [{ text: '-', kind: 'neutral' }];

  return s.recipients.map(r => ({
    text: r.subject ? `${r.name} - ${r.subject}` : `${r.name} - 공강`,
    kind: (r.subject ? 'busy' : 'free') as StatusKind,
  }));
}

function ClassBtn() {
  const [rows, setRows] = useState<Row[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || rows.length === 0) return;
    const w = containerRef.current.offsetWidth + 2;
    const h = rows.length * ROW_H + (rows.length - 1) * ROW_GAP + 2;
    invoke('resize_class_btn', { label: LABEL, width: Math.max(w, 40), height: h }).catch(() => {});
  }, [rows]);

  const refresh = useCallback(async () => {
    try {
      const timetableSource = localStorage.getItem('schoolTimetableSource') || 'comcigan';
      const result = await invoke<ClassStatusResult>('get_class_status', { btnLabel: LABEL, timetableSource });
      setRows(getRows(result));
    } catch {
      // 추적 중이 아닐 때는 조용히 무시
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (rows.length === 0) return null;

  return (
    <div ref={containerRef} className="class-btn-container">
      {rows.map((row, i) => (
        <div key={i} className={`class-btn ${row.kind}`}>
          <span className="class-btn-label">{row.text}</span>
        </div>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClassBtn />
  </React.StrictMode>
);
