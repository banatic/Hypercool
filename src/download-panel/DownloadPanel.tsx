import { useEffect, useRef, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { FileInfo, PanelStatus } from './types';
import { FileItem } from './FileItem';

const SELF = getCurrentWebviewWindow();
const LABEL = SELF.label;

const HOVER_IN_DELAY = 180;
const HOVER_OUT_DELAY = 220;

interface Geometry {
  chip_h: number;
  gap: number;
  panel_h: number;
  expanded: boolean;
  mirror: boolean;
}

export function DownloadPanel() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [status, setStatus] = useState<PanelStatus>('searching');
  const [expanded, setExpanded] = useState(false);
  const [geometry, setGeometry] = useState<Geometry>({
    chip_h: 100,
    gap: 4,
    panel_h: 460,
    expanded: false,
    mirror: false,
  });
  const hoverInTimer = useRef<number | null>(null);
  const hoverOutTimer = useRef<number | null>(null);

  useEffect(() => {
    const unsubs: Promise<() => void>[] = [
      listen<FileInfo[]>('download-panel://files', (e) => setFiles(e.payload)),
      listen<PanelStatus>('download-panel://status', (e) => setStatus(e.payload)),
      listen<Geometry>('download-panel://geometry', (e) => setGeometry(e.payload)),
    ];
    return () => {
      unsubs.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  const sendExpand = useCallback(async (next: boolean) => {
    try {
      await invoke('download_panel_set_expanded', { label: LABEL, expanded: next });
    } catch (err) {
      console.error('set_expanded failed:', err);
    }
  }, []);

  const expand = useCallback(() => {
    if (hoverOutTimer.current) {
      clearTimeout(hoverOutTimer.current);
      hoverOutTimer.current = null;
    }
    if (expanded) return;
    if (hoverInTimer.current) return;
    hoverInTimer.current = window.setTimeout(() => {
      hoverInTimer.current = null;
      setExpanded(true);
      sendExpand(true);
    }, HOVER_IN_DELAY);
  }, [expanded, sendExpand]);

  const collapse = useCallback(() => {
    if (hoverInTimer.current) {
      clearTimeout(hoverInTimer.current);
      hoverInTimer.current = null;
    }
    if (!expanded) return;
    if (hoverOutTimer.current) return;
    hoverOutTimer.current = window.setTimeout(() => {
      hoverOutTimer.current = null;
      setExpanded(false);
      sendExpand(false);
    }, HOVER_OUT_DELAY);
  }, [expanded, sendExpand]);

  const dotClass =
    status === 'connected' ? 'dp-dot--on' : status === 'searching' ? 'dp-dot--wait' : 'dp-dot--off';

  // 패널이 칩 *아래* 에 위치하는지 *위* 에 위치하는지 — geometry에 panel_h, chip_h 만 들어옴.
  // Rust가 모니터 하단 침범 시 위로 폴백할 수 있는데, React는 그걸 직접 알 수 없으니
  // 윈도우 높이를 측정해서 칩이 윈도우 상단인지 하단인지 추정.
  // 간단히: 패널은 항상 칩 아래 모드 (CSS에서 flex column 정렬). Rust의 위쪽 폴백 케이스는 윈도우 자체가
  // 다른 위치에 그려질 뿐, 내부 레이아웃은 동일하게 유지.
  const panelTopPx = geometry.chip_h + geometry.gap;

  // chevron path 분기:
  //   collapsed + right: 우향 ›   (펼치는 방향 = 우측)
  //   collapsed + mirror: 좌향 ‹   (펼치는 방향 = 좌측)
  //   expanded (양쪽 모두): 아래 ⌄ (패널이 칩 아래에 있음)
  const arrowPath = expanded
    ? 'M2 4l5 5 5-5' // ⌄ (down)
    : geometry.mirror
    ? 'M7 2l-5 5 5 5' // ‹ (left)
    : 'M3 2l5 5-5 5'; // › (right)

  // expanded 일 때 chevron viewBox 정렬 — down chevron은 viewBox가 다름
  const arrowViewBox = expanded ? '0 0 14 14' : '0 0 10 14';

  return (
    <div
      className={`dp-root${expanded ? ' dp-root--expanded' : ' dp-root--collapsed'}${geometry.mirror ? ' dp-root--mirror' : ''}`}
      onMouseEnter={expand}
      onMouseLeave={collapse}
    >
      {/* 칩 손잡이 — 항상 렌더 (collapsed/expanded 둘 다 표시) */}
      <div
        className={`dp-chip dp-chip--${status}`}
        title={status === 'connected' ? `${files.length}개 첨부` : '연결 대기'}
      >
        <svg
          className="dp-chip-arrow"
          width={expanded ? 14 : 10}
          height="14"
          viewBox={arrowViewBox}
          fill="none"
          aria-hidden
        >
          <path
            d={arrowPath}
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* 패널 영역 — expanded 일 때만 표시 */}
      {expanded && (
        <div
          className="dp-panel"
          style={{ top: `${panelTopPx}px`, height: `${geometry.panel_h}px` }}
        >
          <header className="dp-header">
            <div className="dp-hdr-left">
              <span className="dp-hdr-icon" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M1.5 1.5h7l3.5 3.5v7.5h-10.5V1.5z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                  <path d="M8.5 1.5v3.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="dp-hdr-title">파일 관리</span>
              {files.length > 0 && <span className="dp-hdr-count">{files.length}</span>}
            </div>
          </header>
          <div className="dp-body">
            {files.length === 0 ? (
              <div className="dp-empty">
                <p className="dp-empty-title">
                  {status === 'connected' ? '첨부 파일 없음' : '쿨메신저 대기 중'}
                </p>
                <p className="dp-empty-sub">
                  {status === 'connected'
                    ? '이 메시지에는 첨부된 파일이 없습니다.'
                    : '메시지 관리함 창을 열어주세요.'}
                </p>
              </div>
            ) : (
              <div className="dp-list">
                {files.map((f) => (
                  <FileItem key={f.path} file={f} />
                ))}
              </div>
            )}
          </div>
          <footer className="dp-footer">
            <span className={`dp-dot ${dotClass}`} />
            <span className="dp-footer-label">
              {status === 'connected' ? `${files.length}개 파일` : status === 'searching' ? '탐색 중…' : '연결 끊김'}
            </span>
          </footer>
        </div>
      )}
    </div>
  );
}
