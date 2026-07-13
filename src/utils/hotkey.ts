// 전역 단축키(accelerator) 유틸.
//
// 백엔드는 global_hotkey 형식의 accelerator 문자열을 파싱한다. 이 파서는
// KeyboardEvent.code 이름(KeyK / Digit1 / Space / F1 / ArrowUp …)과 모디파이어
// 토큰(Control / Alt / Shift / Super)을 그대로 받는다. 따라서 레코더는 e.code 를
// 메인 키 토큰으로 그대로 사용하면 된다.

const MODIFIER_CODE_RE = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** KeyboardEvent → accelerator 문자열. 유효한 조합(모디파이어 1개 이상 + 메인 키)이 아니면 null. */
export function eventToAccelerator(e: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const code = e.code;
  if (!code || MODIFIER_CODE_RE.test(code)) return null; // 모디파이어만 눌린 상태
  if (mods.length === 0) return null; // 전역 단축키는 모디파이어 필수

  return [...mods, code].join('+');
}

const MOD_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
  Super: 'Win',
  Meta: 'Win',
  Command: 'Cmd',
  Cmd: 'Cmd',
};

const ARROW_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** accelerator(예: "Control+Shift+Space")를 사람이 읽기 좋은 라벨("Ctrl + Shift + Space")로 변환. */
export function prettifyAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((raw) => {
      const t = raw.trim();
      if (MOD_LABELS[t]) return MOD_LABELS[t];
      if (ARROW_LABELS[t]) return ARROW_LABELS[t];
      const key = t.match(/^Key([A-Z])$/);
      if (key) return key[1];
      const digit = t.match(/^Digit([0-9])$/);
      if (digit) return digit[1];
      return t;
    })
    .join(' + ');
}
