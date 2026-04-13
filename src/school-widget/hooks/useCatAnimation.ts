import { useRef, useState, useEffect } from 'react';
import {
  CAT_TYPES, CAT_CONFIG,
  CatTypeId, CatState, CatDirection, CatBehavior,
  CatBehaviorSitting, CatBehaviorLying, CatActionPhase,
} from '../types';

function getCatSpriteRow(direction: CatDirection, behaviorType: CatBehavior['type']): number {
  if (behaviorType === 'walking' || behaviorType === 'idle') {
    switch (direction) {
      case 'down': return 0;
      case 'right': return 1;
      case 'up': return 2;
      case 'left': return 3;
    }
  } else {
    switch (behaviorType) {
      case 'sitting': return 4;
      case 'licking': return 5;
      case 'lying': return 6;
      default: return 1;
    }
  }
}

export function useCatAnimation(enabledCats: CatTypeId[], catSize: number) {
  const catStatesRef = useRef<Map<CatTypeId, CatState>>(new Map());
  const catElementsRef = useRef<Map<CatTypeId, HTMLDivElement | null>>(new Map());
  const [visibleCats, setVisibleCats] = useState<Set<CatTypeId>>(new Set());
  const targetPosRef = useRef<{ x: number; y: number } | null>(null);
  const spritePixelDataRef = useRef<Map<string, Map<string, ImageData>>>(new Map());
  const spriteImagesRef = useRef<Map<CatTypeId, HTMLImageElement>>(new Map());

  // Load sprite images and cache pixel data
  useEffect(() => {
    const loadSpriteImage = (catType: typeof CAT_TYPES[number]) => {
      const img = new Image();
      img.src = new URL(`../../asset/${catType.sprite}`, import.meta.url).href;
      img.onload = () => {
        spriteImagesRef.current.set(catType.id, img);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const frameWidth = 32;
        const frameHeight = 32;
        const cols = 4;
        const rows = catType.rows;
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const catPixelData = new Map<string, ImageData>();
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            ctx.clearRect(0, 0, frameWidth, frameHeight);
            ctx.drawImage(img, col * frameWidth, row * frameHeight, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
            catPixelData.set(`${row}-${col}`, ctx.getImageData(0, 0, frameWidth, frameHeight));
          }
        }
        spritePixelDataRef.current.set(catType.id, catPixelData);
      };
    };
    CAT_TYPES.forEach(catType => loadSpriteImage(catType));
  }, []);

  // Mouse tracking
  useEffect(() => {
    const handleMouseMove = (e: Event) => {
      const mouseEvent = e as MouseEvent;
      const container = document.querySelector('.school-widget-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      targetPosRef.current = { x: mouseEvent.clientX - rect.left, y: mouseEvent.clientY - rect.top };
    };
    const handleMouseLeave = () => { targetPosRef.current = null; };
    const container = document.querySelector('.school-widget-container');
    if (container) {
      container.addEventListener('mousemove', handleMouseMove as EventListener);
      container.addEventListener('mouseleave', handleMouseLeave);
    }
    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleMouseMove as EventListener);
        container.removeEventListener('mouseleave', handleMouseLeave);
      }
    };
  }, []);

  // Cat animation loop
  useEffect(() => {
    if (enabledCats.length === 0) {
      catStatesRef.current.clear();
      setVisibleCats(new Set());
      return;
    }

    let animationFrameId: number;
    let lastTime = performance.now();
    let isRunning = true;

    const getBounds = () => {
      const container = document.querySelector('.school-widget-container');
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const halfSize = catSize / 2;
      return { minX: 10 + halfSize, maxX: rect.width - 10 - halfSize, minY: 80 + halfSize, maxY: rect.height - 10 - halfSize };
    };

    const getRandomTarget = (): { x: number; y: number } | null => {
      const bounds = getBounds();
      if (!bounds) return null;
      return {
        x: Math.random() * (bounds.maxX - bounds.minX) + bounds.minX,
        y: Math.random() * (bounds.maxY - bounds.minY) + bounds.minY,
      };
    };

    const getRandomDirection = (): CatDirection => {
      const dirs: CatDirection[] = ['down', 'right', 'up', 'left'];
      return dirs[Math.floor(Math.random() * 4)];
    };

    const getRandomAction = (currentTime: number): CatBehavior => {
      const rand = Math.random();
      if (rand < 0.4) return { type: 'sitting', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime };
      if (rand < 0.7) return { type: 'licking', startTime: currentTime, duration: CAT_CONFIG.LICKING_DURATION };
      return { type: 'lying', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime };
    };

    const getFrameForPhase = (phase: CatActionPhase, phaseStartTime: number, currentTime: number): number => {
      const elapsed = currentTime - phaseStartTime;
      const frameIndex = Math.floor(elapsed / CAT_CONFIG.FRAME_DELAY);
      if (phase === 'enter') return Math.min(frameIndex, 3);
      if (phase === 'hold') return 3;
      return Math.max(3 - frameIndex, 0);
    };

    const getDirectionToTarget = (dx: number, dy: number, currentDir: CatDirection): CatDirection => {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const isHorizontal = currentDir === 'left' || currentDir === 'right';
      if (isHorizontal) {
        if (absDy > absDx * 1.5) return dy > 0 ? 'down' : 'up';
        return dx > 0 ? 'right' : 'left';
      } else {
        if (absDx > absDy * 1.5) return dx > 0 ? 'right' : 'left';
        return dy > 0 ? 'down' : 'up';
      }
    };

    const initCat = (catId: CatTypeId, index: number) => {
      if (catStatesRef.current.has(catId)) return;
      const bounds = getBounds();
      if (!bounds) return;
      const offsetX = (index % 3) * 50;
      const offsetY = Math.floor(index / 3) * 50;
      const centerX = Math.min(bounds.maxX, Math.max(bounds.minX, bounds.minX + offsetX + Math.random() * 100));
      const centerY = Math.min(bounds.maxY, Math.max(bounds.minY, bounds.minY + offsetY + Math.random() * 100));
      const halfSize = catSize / 2;
      catStatesRef.current.set(catId, {
        id: catId, x: centerX - halfSize, y: centerY - halfSize,
        direction: getRandomDirection(),
        behavior: { type: 'walking', target: getRandomTarget() },
        frame: 0,
      });
      setVisibleCats(prev => new Set([...prev, catId]));
    };

    const updateCat = (cat: CatState, currentTime: number, deltaSeconds: number) => {
      const bounds = getBounds();
      if (!bounds) return;
      const halfSize = catSize / 2;
      const catCenterX = cat.x + halfSize;
      const catCenterY = cat.y + halfSize;
      const moveDistance = CAT_CONFIG.MOVE_SPEED * deltaSeconds;
      const mousePos = targetPosRef.current;

      switch (cat.behavior.type) {
        case 'idle': {
          cat.behavior = { type: 'walking', target: getRandomTarget() };
          break;
        }
        case 'walking': {
          let targetX: number, targetY: number;
          const isRandomWandering = !mousePos;
          if (mousePos) {
            targetX = Math.max(bounds.minX, Math.min(bounds.maxX, mousePos.x));
            targetY = Math.max(bounds.minY, Math.min(bounds.maxY, mousePos.y));
            cat.behavior.target = null;
          } else if (cat.behavior.target) {
            targetX = cat.behavior.target.x;
            targetY = cat.behavior.target.y;
          } else {
            const newTarget = getRandomTarget();
            if (newTarget) { cat.behavior.target = newTarget; targetX = newTarget.x; targetY = newTarget.y; }
            else { targetX = catCenterX; targetY = catCenterY; }
          }
          const dx = targetX - catCenterX;
          const dy = targetY - catCenterY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const arrivalThreshold = isRandomWandering ? 5 : 2;
          if (distance <= arrivalThreshold) {
            if (isRandomWandering) { cat.behavior = getRandomAction(currentTime); }
            else { cat.behavior = { type: 'sitting', phase: 'hold', phaseStartTime: currentTime, actionStartTime: currentTime }; cat.frame = 3; }
          } else {
            const newCenterX = Math.max(bounds.minX, Math.min(bounds.maxX, catCenterX + (dx / distance) * moveDistance));
            const newCenterY = Math.max(bounds.minY, Math.min(bounds.maxY, catCenterY + (dy / distance) * moveDistance));
            cat.x = newCenterX - halfSize;
            cat.y = newCenterY - halfSize;
            cat.direction = getDirectionToTarget(dx, dy, cat.direction);
            cat.frame = Math.floor(currentTime / CAT_CONFIG.FRAME_DELAY) % 4;
          }
          break;
        }
        case 'sitting':
        case 'lying': {
          const behavior = cat.behavior as CatBehaviorSitting | CatBehaviorLying;
          const elapsed = currentTime - behavior.phaseStartTime;
          const totalActionTime = currentTime - behavior.actionStartTime;
          if (mousePos && totalActionTime >= CAT_CONFIG.MIN_ACTION_DURATION) {
            const dx = mousePos.x - catCenterX;
            const dy = mousePos.y - catCenterY;
            if (Math.sqrt(dx * dx + dy * dy) > 10) { cat.behavior = { type: 'walking', target: null }; break; }
          }
          if (behavior.phase === 'enter' && elapsed >= CAT_CONFIG.ENTER_DURATION) {
            cat.behavior = { ...behavior, phase: 'hold', phaseStartTime: currentTime };
          } else if (behavior.phase === 'hold' && elapsed >= CAT_CONFIG.HOLD_DURATION) {
            cat.behavior = { ...behavior, phase: 'exit', phaseStartTime: currentTime };
          } else if (behavior.phase === 'exit' && elapsed >= CAT_CONFIG.EXIT_DURATION) {
            cat.behavior = { type: 'walking', target: getRandomTarget() };
            cat.direction = getRandomDirection();
          }
          cat.frame = getFrameForPhase(behavior.phase, behavior.phaseStartTime, currentTime);
          break;
        }
        case 'licking': {
          const elapsed = currentTime - cat.behavior.startTime;
          if (mousePos && elapsed >= CAT_CONFIG.MIN_ACTION_DURATION) {
            const dx = mousePos.x - catCenterX;
            const dy = mousePos.y - catCenterY;
            if (Math.sqrt(dx * dx + dy * dy) > 10) { cat.behavior = { type: 'walking', target: null }; break; }
          }
          if (elapsed >= cat.behavior.duration) {
            cat.behavior = { type: 'walking', target: getRandomTarget() };
            cat.direction = getRandomDirection();
          } else {
            cat.frame = Math.floor(currentTime / CAT_CONFIG.FRAME_DELAY) % 4;
          }
          break;
        }
      }
    };

    const animate = (currentTime: number) => {
      if (!isRunning) return;
      const deltaSeconds = (currentTime - lastTime) / 1000;
      lastTime = currentTime;
      catStatesRef.current.forEach((cat) => {
        updateCat(cat, currentTime, deltaSeconds);
        const el = catElementsRef.current.get(cat.id);
        if (el) {
          el.style.left = `${cat.x}px`;
          el.style.top = `${cat.y}px`;
          const row = getCatSpriteRow(cat.direction, cat.behavior.type);
          el.style.backgroundPosition = `-${cat.frame * catSize}px -${row * catSize}px`;
        }
      });
      animationFrameId = requestAnimationFrame(animate);
    };

    const initTimeouts = enabledCats.map((catId, index) =>
      setTimeout(() => initCat(catId, index), CAT_CONFIG.INIT_DELAY + index * 500)
    );

    animationFrameId = requestAnimationFrame(animate);

    return () => {
      isRunning = false;
      initTimeouts.forEach(clearTimeout);
      cancelAnimationFrame(animationFrameId);
    };
  }, [enabledCats, catSize]);

  const isPixelHit = (
    catTypeId: CatTypeId, clickX: number, clickY: number,
    catX: number, catY: number, size: number,
    direction: CatDirection, behaviorType: CatBehavior['type'], frame: number,
  ): boolean => {
    if (clickX < catX || clickX > catX + size || clickY < catY || clickY > catY + size) return false;
    const catPixelData = spritePixelDataRef.current.get(catTypeId);
    if (!catPixelData || catPixelData.size === 0) return true;
    const localX = clickX - catX;
    const localY = clickY - catY;
    const originalFrameSize = 32;
    const scale = size / originalFrameSize;
    const originalX = Math.floor(localX / scale);
    const originalY = Math.floor(localY / scale);
    if (originalX < 0 || originalX >= originalFrameSize || originalY < 0 || originalY >= originalFrameSize) return false;
    const row = getCatSpriteRow(direction, behaviorType);
    const pixelData = catPixelData.get(`${row}-${frame}`);
    if (!pixelData) return true;
    const alpha = pixelData.data[(originalY * originalFrameSize + originalX) * 4 + 3];
    return alpha > 0;
  };

  return { catStatesRef, catElementsRef, visibleCats, setVisibleCats, isPixelHit };
}
