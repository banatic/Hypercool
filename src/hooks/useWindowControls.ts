import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface WindowControlOptions {
  edgeSize?: number;
  minWidth?: number;
  minHeight?: number;
  blurSigma?: number;
  tint?: [number, number, number, number];
}

export function useWindowControls(options: WindowControlOptions = {}) {
  const {
    edgeSize = 8,
    minWidth = 350,
    minHeight = 450,
    blurSigma = 25,
    tint = [25, 25, 30, 90], // Default semi-transparent dark tint
  } = options;

  const [bgImage, setBgImage] = useState<string | null>(null);
  const windowRef = useRef(getCurrentWindow());
  const isResizingRef = useRef<string | null>(null);
  const isDraggingRef = useRef(false);
  const startMousePosRef = useRef({ x: 0, y: 0 });
  const startWindowRectRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const lastUpdateRef = useRef(0);

  const updateBackground = async () => {
    const now = Date.now();
    if (now - lastUpdateRef.current < 32) return; // Throttle to ~30fps
    lastUpdateRef.current = now;

    const win = windowRef.current;
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    
    try {
      const b64 = await invoke<string>('get_blurred_background', {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        blurSigma,
        tint,
      });
      setBgImage(b64);
    } catch (e) {
      console.error('Failed to update background blur:', e);
    }
  };

  useEffect(() => {
    updateBackground();
    
    // Resize observer for window size changes (e.g. from system or other commands)
    const handleResize = () => updateBackground();
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const handleMouseMove = async (e: React.MouseEvent | MouseEvent) => {
    if (isResizingRef.current || isDraggingRef.current) return;

    const { clientX: x, clientY: y } = e;
    const width = window.innerWidth;
    const height = window.innerHeight;

    let cursor = 'default';
    let edge = '';

    if (x < edgeSize) edge += 'w';
    else if (x > width - edgeSize) edge += 'e';

    if (y < edgeSize) edge += 'n';
    else if (y > height - edgeSize) edge += 's';

    if (edge === 'n' || edge === 's') cursor = 'ns-resize';
    else if (edge === 'e' || edge === 'w') cursor = 'ew-resize';
    else if (edge === 'nw' || edge === 'se') cursor = 'nwse-resize';
    else if (edge === 'ne' || edge === 'sw') cursor = 'nesw-resize';

    const win = windowRef.current;
    await win.setCursorIcon(cursor as any);
  };

  const handleMouseDown = async (e: React.MouseEvent) => {
    const { clientX: x, clientY: y } = e;
    const width = window.innerWidth;
    const height = window.innerHeight;

    let edge = '';
    if (x < edgeSize) edge += 'w';
    else if (x > width - edgeSize) edge += 'e';

    if (y < edgeSize) edge += 'n';
    else if (y > height - edgeSize) edge += 's';

    if (edge) {
      e.preventDefault();
      e.stopPropagation();
      isResizingRef.current = edge;
      const win = windowRef.current;
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      
      startMousePosRef.current = { x: e.screenX, y: e.screenY };
      startWindowRectRef.current = { x: pos.x, y: pos.y, width: size.width, height: size.height };
      
      window.addEventListener('mousemove', globalMouseMove);
      window.addEventListener('mouseup', globalMouseUp);
    } else {
      const target = e.target as HTMLElement;
      if (target.closest('[data-window-drag-region]')) {
        // We use our custom drag logic to ensure background updates
        isDraggingRef.current = true;
        const win = windowRef.current;
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        
        startMousePosRef.current = { x: e.screenX, y: e.screenY };
        startWindowRectRef.current = { x: pos.x, y: pos.y, width: size.width, height: size.height };
        
        window.addEventListener('mousemove', globalMouseMove);
        window.addEventListener('mouseup', globalMouseUp);
      }
    }
  };

  const globalMouseMove = async (e: MouseEvent) => {
    const dx = e.screenX - startMousePosRef.current.x;
    const dy = e.screenY - startMousePosRef.current.y;

    if (isResizingRef.current) {
      const edge = isResizingRef.current;
      let { x, y, width, height } = startWindowRectRef.current;

      if (edge.includes('w')) {
        const newWidth = Math.max(minWidth, width - dx);
        x += (width - newWidth);
        width = newWidth;
      } else if (edge.includes('e')) {
        width = Math.max(minWidth, width + dx);
      }

      if (edge.includes('n')) {
        const newHeight = Math.max(minHeight, height - dy);
        y += (height - newHeight);
        height = newHeight;
      } else if (edge.includes('s')) {
        height = Math.max(minHeight, height + dy);
      }

      await invoke('update_window_position_size', { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
      updateBackground();
    } else if (isDraggingRef.current) {
      const x = startWindowRectRef.current.x + dx;
      const y = startWindowRectRef.current.y + dy;
      const { width, height } = startWindowRectRef.current;
      
      await invoke('update_window_position_size', { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
      updateBackground();
    }
  };

  const globalMouseUp = () => {
    isResizingRef.current = null;
    isDraggingRef.current = false;
    window.removeEventListener('mousemove', globalMouseMove);
    window.removeEventListener('mouseup', globalMouseUp);
  };

  return { bgImage, handleMouseMove, handleMouseDown, updateBackground };
}
