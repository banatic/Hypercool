import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileInfo } from './types';
import { getExtStyle, formatSize, truncate } from './extStyle';

interface Props {
  file: FileInfo;
}

interface FileMeta {
  exists: boolean;
  size: number | null;
  modified: string | null;
}

export function FileItem({ file }: Props) {
  const [hovered, setHovered] = useState(false);
  // 폴링이 재emit 하지 않아 stale 할 수 있는 exists 를, 열기/hover 시점에
  // 백엔드로 재확인한 최신 결과. null 이면 props(file) 값을 그대로 사용.
  const [live, setLive] = useState<FileMeta | null>(null);
  const { style, label } = getExtStyle(file.name);

  // 폴링이 새 목록을 emit 하면(경로 또는 exists 변화) 백엔드 truth 를 우선.
  useEffect(() => {
    setLive(null);
  }, [file.path, file.exists]);

  // props + 재확인 결과를 합친 유효 상태.
  const exists = live?.exists ?? file.exists;
  const size = live ? live.size : file.size;
  const modified = live ? live.modified : file.modified;
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

  // 파일 열기 시점에 presence 를 다시 감지한다. 다운로드 직후 폴링이
  // 갱신하지 못해 exists 가 stale-false 여도, 여기서 재확인해 실제로 파일이
  // 있으면 바로 연다. (다른 창을 갔다 와야 열리던 문제 해결)
  const handleOpen = async (e: React.MouseEvent) => {
    e.stopPropagation();
    let canOpen = exists;
    if (!canOpen) {
      try {
        const meta = await invoke<FileMeta>('download_panel_recheck_file', { path: file.path });
        setLive(meta);
        canOpen = meta.exists;
      } catch (err) {
        console.error('recheck_file failed:', err);
      }
    }
    if (!canOpen) return;
    try {
      await invoke('open_file', { filePath: file.path });
    } catch (err) {
      console.error('open_file failed:', err);
    }
  };

  // hover 시점에도 pending 이면 한 번 재확인해 열기 버튼을 미리 활성화한다.
  const handleEnter = () => {
    setHovered(true);
    if (!exists) {
      invoke<FileMeta>('download_panel_recheck_file', { path: file.path })
        .then((meta) => {
          if (meta.exists) setLive(meta);
        })
        .catch(() => {});
    }
  };

  const meta = exists
    ? [formatSize(size), modified].filter(Boolean).join('  ·  ')
    : '다운로드 대기';

  return (
    <div
      className={`dp-file${hovered ? ' dp-file--hov' : ''}${!exists ? ' dp-file--dim' : ''}`}
      onMouseEnter={handleEnter}
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
        <div className={`dp-file-meta${!exists ? ' dp-file-meta--pending' : ''}`}>{meta}</div>
      </div>
      <button
        className={`dp-open${hovered && exists ? ' dp-open--vis' : ''}`}
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
