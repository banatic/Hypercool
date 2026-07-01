import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// @tauri-apps/api 는 ResizeDirection 타입을 export 하지 않으므로 로컬 정의
type ResizeDir =
  | 'North' | 'South' | 'East' | 'West'
  | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

const T = 8; // 핸들 두께(px)

const HANDLES: { dir: ResizeDir; style: React.CSSProperties; cursor: string }[] = [
  { dir: 'North',     style: { top: 0, left: T, right: T, height: T }, cursor: 'ns-resize' },
  { dir: 'South',     style: { bottom: 0, left: T, right: T, height: T }, cursor: 'ns-resize' },
  { dir: 'West',      style: { left: 0, top: T, bottom: T, width: T }, cursor: 'ew-resize' },
  { dir: 'East',      style: { right: 0, top: T, bottom: T, width: T }, cursor: 'ew-resize' },
  { dir: 'NorthWest', style: { top: 0, left: 0, width: T, height: T }, cursor: 'nwse-resize' },
  { dir: 'NorthEast', style: { top: 0, right: 0, width: T, height: T }, cursor: 'nesw-resize' },
  { dir: 'SouthWest', style: { bottom: 0, left: 0, width: T, height: T }, cursor: 'nesw-resize' },
  { dir: 'SouthEast', style: { bottom: 0, right: 0, width: T, height: T }, cursor: 'nwse-resize' },
];

interface ResizeHandlesProps {
  /** 리사이즈 가능(핀 고정) 상태일 때만 핸들을 렌더링 */
  enabled: boolean;
}

/**
 * decorations:false + transparent 창은 웹뷰가 클라이언트 영역을 전부 덮어
 * OS 네이티브 가장자리 리사이즈가 동작하지 않는다. 창 테두리에 얇은 오버레이
 * 핸들을 깔고 startResizeDragging()으로 OS 리사이즈 루프를 직접 시작한다.
 * send_window_to_bottom 리스너가 리사이즈를 가로채지 않도록 data-resize-handle 표식을 둔다.
 */
export default function ResizeHandles({ enabled }: ResizeHandlesProps) {
  if (!enabled) return null;

  const startResize = (dir: ResizeDir) => (e: React.MouseEvent) => {
    if (e.button !== 0) return; // 좌클릭만
    e.preventDefault();
    e.stopPropagation();
    getCurrentWindow().startResizeDragging(dir).catch(console.error);
  };

  return (
    <>
      {HANDLES.map(({ dir, style, cursor }) => (
        <div
          key={dir}
          data-resize-handle
          onMouseDown={startResize(dir)}
          style={{
            position: 'fixed',
            zIndex: 2147483647,
            cursor,
            // 투명하지만 포인터 이벤트는 받도록
            background: 'transparent',
            ...style,
          }}
        />
      ))}
    </>
  );
}
