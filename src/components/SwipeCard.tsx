import React, { useEffect, useRef } from 'react';
import { animateSpring, project, clamp, prefersReducedMotion, SpringHandle } from '../utils/spring';

// 드래그로 인정하기 전 요구되는 최소 이동(히스테리시스, §10) — 탭/클릭과 구분한다.
const MOVE_THRESHOLD = 8;
// 투영된 착지점이 카드 폭의 이 비율을 넘으면 커밋한다(§6).
const COMMIT_RATIO = 0.32;

interface SwipeCardProps {
  className?: string;
  onSwipe: (direction: 'left' | 'right') => void;
  children: React.ReactNode;
}

interface Sample {
  t: number;
  x: number;
}

/**
 * 손가락에 1:1로 붙고(§2), 놓은 속도를 그대로 이어받아(§5) 던진 방향으로
 * 감속하며(§6) 나온 방향으로 화면 밖으로 사라지는(§7) 스와이프 카드.
 * 비행 중 다시 누르면 현재 표시값에서 재파지되어 방향을 되돌릴 수 있다(§3).
 */
export const SwipeCard: React.FC<SwipeCardProps> = ({ className = '', onSwipe, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const spring = useRef<SpringHandle | null>(null);
  const curX = useRef(0);
  const curY = useRef(0);

  // 제스처 상태 (리렌더를 유발하지 않도록 ref에 보관)
  const gesture = useRef({
    pointerId: -1,
    grabX: 0,
    grabY: 0,
    dragging: false,
    decided: false,
    history: [] as Sample[],
  });

  useEffect(() => {
    return () => spring.current?.stop();
  }, []);

  const paint = (x: number, y: number, preview = true) => {
    const el = ref.current;
    if (!el) return;
    const rot = clamp(x / 18, -14, 14);
    el.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
    if (preview) {
      const bound = el.offsetWidth * COMMIT_RATIO;
      el.classList.toggle('preview-right', x > bound);
      el.classList.toggle('preview-left', x < -bound);
    }
  };

  const velocity = (): number => {
    const h = gesture.current.history;
    if (h.length < 2) return 0;
    const a = h[0];
    const b = h[h.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return 0;
    return ((b.x - a.x) / dt) * 1000; // px/s
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    // 액션 버튼/링크에서 시작한 포인터는 클릭으로 흘려보낸다.
    if ((e.target as HTMLElement).closest('button, a')) return;

    // 비행 중이면 중단하고 현재 표시값에서 재파지한다(§3).
    spring.current?.stop();
    spring.current = null;

    const g = gesture.current;
    g.pointerId = e.pointerId;
    g.grabX = e.clientX - curX.current; // 잡은 위치의 오프셋 존중(§2)
    g.grabY = e.clientY - curY.current;
    g.dragging = true;
    g.decided = false;
    g.history = [{ t: e.timeStamp, x: e.clientX }];
    el.style.transition = 'none';
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.dragging || e.pointerId !== g.pointerId) return;

    const x = e.clientX - g.grabX;
    const y = e.clientY - g.grabY;
    g.history.push({ t: e.timeStamp, x: e.clientX });
    if (g.history.length > 6) g.history.shift();

    if (!g.decided) {
      if (Math.abs(x) < MOVE_THRESHOLD && Math.abs(y) < MOVE_THRESHOLD) return;
      g.decided = true;
      ref.current?.classList.add('dragging');
    }

    curX.current = x;
    curY.current = y * 0.25; // 세로는 완만하게 따라오게(디커플, §3)
    paint(curX.current, curY.current);
  };

  const settleBack = (vx: number) => {
    const el = ref.current;
    if (!el) return;
    const startX = curX.current;
    const startY = curY.current;
    if (prefersReducedMotion()) {
      curX.current = 0;
      curY.current = 0;
      paint(0, 0);
      el.classList.remove('preview-left', 'preview-right');
      return;
    }
    spring.current = animateSpring({
      from: startX,
      to: 0,
      velocity: vx,
      onUpdate: (v) => {
        curX.current = v;
        // 세로를 가로 진행률에 묶어 함께 0으로 수렴시킨다.
        curY.current = startX !== 0 ? startY * (v / startX) : 0;
        paint(v, curY.current);
      },
      onComplete: () => {
        el.classList.remove('preview-left', 'preview-right');
        curX.current = 0;
        curY.current = 0;
      },
    });
  };

  const flyOut = (dir: 'left' | 'right', vx: number) => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      onSwipe(dir);
      return;
    }
    const width = el.offsetWidth;
    const target = (dir === 'right' ? 1 : -1) * (window.innerWidth + width);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      spring.current?.stop();
      onSwipe(dir);
    };
    spring.current = animateSpring({
      from: curX.current,
      to: target,
      velocity: vx,
      stiffness: 120,
      damping: 19, // 약간 언더댐프 — 화면 밖까지 코스팅
      onUpdate: (v) => {
        const rot = clamp(v / 18, -20, 20);
        el.style.opacity = String(Math.max(0, 1 - Math.abs(v) / (width * 1.1)));
        el.style.transform = `translate(${v}px, ${curY.current}px) rotate(${rot}deg)`;
        if (Math.abs(v) > window.innerWidth) finish(); // 화면을 벗어나면 즉시 확정
      },
      onComplete: finish,
    });
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (e.pointerId !== g.pointerId) return;
    g.dragging = false;
    const el = ref.current;
    try {
      el?.releasePointerCapture(e.pointerId);
    } catch {
      /* 이미 해제됨 */
    }
    if (!el) return;
    el.classList.remove('dragging');

    if (!g.decided) {
      // 문턱을 못 넘음 → 클릭으로 간주, 원위치.
      el.style.transition = '';
      return;
    }

    const vx = velocity();
    const projected = curX.current + project(vx);
    const commit = Math.abs(projected) > el.offsetWidth * COMMIT_RATIO;
    if (commit) {
      flyOut(projected > 0 ? 'right' : 'left', vx);
    } else {
      settleBack(vx);
    }
  };

  return (
    <div
      ref={ref}
      className={className}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      {children}
    </div>
  );
};
