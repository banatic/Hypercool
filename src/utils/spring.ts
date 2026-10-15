// 의존성 없는 "유동적 인터페이스"(WWDC 2018) 모션 헬퍼.
// requestAnimationFrame 기반 스프링 + 모멘텀 투영으로, 제스처가 놓인 속도를
// 그대로 이어받아(§5) 던진 곳으로 감속(§6)하고, 언제든 중단·재설정(§3)할 수 있다.

/**
 * 플릭의 착지점을 릴리스 속도로부터 투영한다. iOS 스크롤 감속과 동일한
 * 지수 감쇠 모델. (물리 교과서의 v²/2a 가 아니라 Apple 샘플의 지수식)
 * @param velocity 릴리스 속도 (px/s)
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export interface SpringHandle {
  stop(): void;
}

export interface SpringConfig {
  from: number;
  to: number;
  /** 제스처에서 인계받는 초기 속도 (px/s) */
  velocity?: number;
  /** 강성. 클수록 빠르게 도달 */
  stiffness?: number;
  /** 감쇠. 기본값은 오버슈트 없는 임계 감쇠에 가깝다 */
  damping?: number;
  restDistance?: number;
  restVelocity?: number;
  onUpdate(value: number, velocity: number): void;
  onComplete?(): void;
}

/**
 * 스칼라 하나를 스프링으로 애니메이션한다. 중단 가능: stop() 후 현재
 * 표시값(presentation value)에서 새 스프링을 시작하면 비행 중 방향을 바꿀 수 있다.
 * 기본값은 오버슈트 없는(≈임계 감쇠) response ≈ 0.4s.
 */
export function animateSpring(cfg: SpringConfig): SpringHandle {
  const stiffness = cfg.stiffness ?? 180;
  const damping = cfg.damping ?? 26; // ≈ 2*sqrt(stiffness) → 임계 감쇠
  const restDistance = cfg.restDistance ?? 0.4;
  const restVelocity = cfg.restVelocity ?? 2;

  let value = cfg.from;
  let velocity = cfg.velocity ?? 0;
  let raf = 0;
  let last = 0;
  let stopped = false;

  const step = (t: number) => {
    if (stopped) return;
    if (!last) last = t;
    let dt = (t - last) / 1000;
    last = t;
    if (dt > 1 / 30) dt = 1 / 30; // 탭 전환 등으로 프레임이 밀렸을 때 폭주 방지

    // 고정 서브스텝으로 적분 안정성 확보
    const subSteps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / subSteps;
    for (let i = 0; i < subSteps; i++) {
      const springForce = -stiffness * (value - cfg.to);
      const dampingForce = -damping * velocity;
      const accel = springForce + dampingForce; // mass = 1
      velocity += accel * h;
      value += velocity * h;
    }

    if (Math.abs(cfg.to - value) < restDistance && Math.abs(velocity) < restVelocity) {
      value = cfg.to;
      cfg.onUpdate(value, 0);
      cfg.onComplete?.();
      return;
    }
    cfg.onUpdate(value, velocity);
    raf = requestAnimationFrame(step);
  };

  raf = requestAnimationFrame(step);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
