import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileInfo } from './types';
import { getExtStyle, formatSize, truncate } from './extStyle';

interface Props {
  file: FileInfo;
}

export function FileItem({ file }: Props) {
  const [hovered, setHovered] = useState(false);
  const { style, label } = getExtStyle(file.name);
  const nameWrapRef = useRef<HTMLDivElement>(null);
  const nameTrackRef = useRef<HTMLSpanElement>(null);
  // 텍스트가 컨테이너보다 클 때 좌측으로 밀어야 할 픽셀 양 (양수). 0 이면 marquee 비활성.
  const [marqueeDist, setMarqueeDist] = useState(0);

  const truncated = truncate(file.name, 28);

  // 텍스트/컨테이너 폭 측정 → marquee 거리 계산
  const measure = () => {
    const wrap = nameWrapRef.current;
    const track = nameTrackRef.current;
    if (!wrap || !track) return;
    const overflow = track.scrollWidth - wrap.clientWidth;
    setMarqueeDist(overflow > 4 ? overflow + 8 /* 끝까지 보이도록 여백 */ : 0);
  };

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [truncated]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpen = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!file.exists) return;
    try {
      await invoke('open_file', { filePath: file.path });
    } catch (err) {
      console.error('open_file failed:', err);
    }
  };

  const meta = file.exists
    ? [formatSize(file.size), file.modified].filter(Boolean).join('  ·  ')
    : '다운로드 대기';

  return (
    <div
      className={`dp-file${hovered ? ' dp-file--hov' : ''}${!file.exists ? ' dp-file--dim' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={handleOpen}
      title={file.name}
    >
      <span
        className="dp-ext"
        style={{ background: style.bg, color: style.fg }}
      >
        {label}
      </span>
      <div className="dp-file-body">
        <div className="dp-file-name" ref={nameWrapRef}>
          <span
            ref={nameTrackRef}
            className={`dp-file-name-track${marqueeDist > 0 ? ' dp-file-name-track--scrolls' : ''}`}
            style={
              marqueeDist > 0
                ? ({ '--marquee-dist': `-${marqueeDist}px` } as React.CSSProperties)
                : undefined
            }
          >
            {truncated}
          </span>
        </div>
        <div className={`dp-file-meta${!file.exists ? ' dp-file-meta--pending' : ''}`}>{meta}</div>
      </div>
      <button
        className={`dp-open${hovered && file.exists ? ' dp-open--vis' : ''}`}
        onClick={handleOpen}
        tabIndex={-1}
        aria-hidden
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 10L10 2M10 2H5M10 2v5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
