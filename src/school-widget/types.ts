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
  classroom?: string;
}

export interface AppinData {
  teachers: string[];
  subjects: string[];
  days: Record<string, Record<string, Record<string, AppinTimetableSlot>>>;
}

export type Tab = 'todo' | 'meal' | 'timetable' | 'attendance' | 'points' | 'settings';

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
  { id: 'settings', label: '설정' },
];
