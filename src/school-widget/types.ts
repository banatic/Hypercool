export interface TimetableData {
  teachers: string[];
  subjects: string[];
  timetables: Record<string, string[][][]>;
}

export interface MealInfo {
  lunch: string;
  dinner: string;
}

export interface Latecomer {
  student_info: string;
  arrival_time: string;
  attendance_status: string;
}

export interface PointStatus {
  student_info: string;
  reward: number;
  penalty: number;
  offset: number;
  total: number;
}

export interface AppinTimetableSlot {
  subject: number | null;
  teacher: number | null;
  room?: number | null;
  /** 보강·교체로 교사가 바뀐 경우 원래 교사 */
  origTeacher?: number;
  /** 결강 사유 (absences 인덱스) */
  absence?: number;
  /** 결강 교사 (다른 수업을 옮겨와 보강하면 origTeacher 없이 여기에만 있음) */
  absentTeacher?: number;
  /** 다른 시간에서 옮겨온 수업의 원래 위치 "YYYY-MM-DD/교시" */
  movedFrom?: string;
  /** 분반: 같은 학반·교시에 동시에 진행되는 나머지 수업 */
  extra?: AppinTimetableSlot[];
}

export interface AppinData {
  teachers: string[];
  subjects: string[];
  classes: string[];
  events: string[];
  rooms: string[];
  absences: string[];
  days: Record<string, Record<string, Record<string, AppinTimetableSlot>>>;
  eventsByDateClass: Record<string, Record<string, string>>;
  eventsByDateGrade: Record<string, (string | null)[]>;
  /** 학교 전체가 하루 종일 행사인 날 → 행사 이름 (공휴일·방학·체육대회 등) */
  fullDayEvents: Record<string, string>;
  /** 압핀 시정표: 날짜 → 교시 → [시작, 종료] ("HH:MM") */
  periodTimes: Record<string, Record<string, [string, string]>>;
}

export type AppinChange =
  | { kind: 'cover'; absentTeacher: string; reason?: string }   // 내가 들어가는 보강·교체
  | { kind: 'covered'; substitute: string; reason?: string }    // 내 수업을 다른 교사가 맡음
  | { kind: 'moved'; from: string };                            // 다른 시간에서 옮겨온 수업

export interface AppinLesson {
  subject: string;
  className: string;
  change?: AppinChange;
}

export type Tab = 'todo' | 'meal' | 'timetable' | 'attendance' | 'points' | 'shortcut' | 'settings' | 'stock';

export interface Shortcut {
  id: string;
  url: string;
  name: string;
}

export type CatDirection = 'down' | 'right' | 'up' | 'left';
export type CatActionPhase = 'enter' | 'hold' | 'exit';

export interface CatBehaviorIdle {
  type: 'idle';
}

export interface CatBehaviorWalking {
  type: 'walking';
  target: { x: number; y: number } | null;
}

export interface CatBehaviorSitting {
  type: 'sitting';
  phase: CatActionPhase;
  phaseStartTime: number;
  actionStartTime: number;
}

export interface CatBehaviorLicking {
  type: 'licking';
  startTime: number;
  duration: number;
}

export interface CatBehaviorLying {
  type: 'lying';
  phase: CatActionPhase;
  phaseStartTime: number;
  actionStartTime: number;
}

export type CatBehavior =
  | CatBehaviorIdle
  | CatBehaviorWalking
  | CatBehaviorSitting
  | CatBehaviorLicking
  | CatBehaviorLying;

export interface CatState {
  id: CatTypeId;
  x: number;
  y: number;
  direction: CatDirection;
  behavior: CatBehavior;
  frame: number;
}

export const CAT_TYPES = [
  { id: 'default', name: '기본', sprite: 'stardew-cat.png', rows: 8 },
  { id: 'orange', name: '주황이', sprite: 'stardew-cat-orange.png', rows: 8 },
  { id: 'gray', name: '회색이', sprite: 'stardew-cat-gray.png', rows: 8 },
  { id: 'black', name: '까망이', sprite: 'stardew-cat-black.png', rows: 9 },
  { id: 'white', name: '하양이', sprite: 'stardew-cat-white.png', rows: 9 },
  { id: 'purple', name: '보라', sprite: 'stardew-cat-purple.png', rows: 9 },
] as const;

export type CatTypeId = typeof CAT_TYPES[number]['id'];

export const CAT_CONFIG = {
  FRAME_DELAY: 150,
  MOVE_SPEED: 30,
  ENTER_DURATION: 150 * 4,
  HOLD_DURATION: 3000,
  EXIT_DURATION: 150 * 4,
  LICKING_DURATION: 3000,
  MIN_ACTION_DURATION: 5000,
  INIT_DELAY: 1000,
  IDLE_MIN: 2000,
  IDLE_MAX: 4000,
};

export const PERIOD_START_TIMES: Record<number, string> = {
  1: '08:30', 2: '09:30', 3: '10:30', 4: '11:30',
  5: '13:20', 6: '14:20', 7: '15:20',
};

export const PERIOD_TIMES = [
  { start: 8 * 60 + 30, end: 9 * 60 + 20 },
  { start: 9 * 60 + 30, end: 10 * 60 + 20 },
  { start: 10 * 60 + 30, end: 11 * 60 + 20 },
  { start: 11 * 60 + 30, end: 12 * 60 + 20 },
  { start: 12 * 60 + 20, end: 13 * 60 + 20 }, // 점심시간
  { start: 13 * 60 + 20, end: 14 * 60 + 10 },
  { start: 14 * 60 + 20, end: 15 * 60 + 10 },
  { start: 15 * 60 + 20, end: 16 * 60 + 10 },
];

export const ALL_TABS: { id: Tab; label: string }[] = [
  { id: 'todo', label: '할 일' },
  { id: 'meal', label: '급식' },
  { id: 'timetable', label: '시간표' },
  { id: 'attendance', label: '출결' },
  { id: 'points', label: '상벌점' },
  { id: 'shortcut', label: '바로가기' },
  { id: 'settings', label: '설정' },
];
