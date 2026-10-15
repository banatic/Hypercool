/**
 * public/hypercool-widget.js 를 Scriptable 밖에서 실행해 본다.
 * Scriptable 전역(ListWidget, Keychain, Request …)을 최소한으로 흉내 내고,
 * 데이터 변환·인증 갱신·캐시 폴백·위젯 텍스트를 확인한다.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = readFileSync(path.resolve(__dirname, '../public/hypercool-widget.js'), 'utf8');

interface Sandbox {
  texts: string[];
  keychain: Map<string, string>;
  files: Map<string, string>;
  requests: { url: string; body?: string; headers?: Record<string, string> }[];
  responses: unknown[];
  __hypercool: any;
}

function makeSandbox(): Sandbox & Record<string, unknown> {
  const texts: string[] = [];
  const keychain = new Map<string, string>();
  const files = new Map<string, string>();
  const requests: Sandbox['requests'] = [];
  const responses: unknown[] = [];

  class Color {
    hex: string;
    constructor(hex: string) { this.hex = hex; }
    static dynamic(l: Color) { return l; }
  }
  class Size {
    w: number; h: number;
    constructor(w: number, h: number) { this.w = w; this.h = h; }
  }
  const Font = new Proxy({}, { get: () => (size: number) => ({ size }) });
  class Stack {
    size?: Size; cornerRadius = 0; backgroundColor?: Color; spacing = 0; url?: string; refreshAfterDate?: Date;
    addText(t: string) { texts.push(t); return { font: null, textColor: null, lineLimit: 0, minimumScaleFactor: 1 }; }
    addStack() { return new Stack(); }
    addSpacer() {}
    setPadding() {}
    layoutVertically() {}
    centerAlignContent() {}
    bottomAlignContent() {}
    topAlignContent() {}
    async presentSmall() {}
    async presentMedium() {}
    async presentLarge() {}
  }
  class Request {
    method = 'GET'; headers: Record<string, string> = {}; body?: string; url: string;
    constructor(url: string) { this.url = url; }
    async loadJSON() {
      requests.push({ url: this.url, body: this.body, headers: this.headers });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  }
  const Keychain = {
    contains: (k: string) => keychain.has(k),
    get: (k: string) => { if (!keychain.has(k)) throw new Error('missing'); return keychain.get(k)!; },
    set: (k: string, v: string) => { keychain.set(k, v); },
    remove: (k: string) => { keychain.delete(k); },
  };
  const FileManager = {
    local: () => ({
      libraryDirectory: () => '/lib',
      joinPath: (a: string, b: string) => `${a}/${b}`,
      fileExists: (p: string) => files.has(p),
      readString: (p: string) => files.get(p)!,
      writeString: (p: string, s: string) => { files.set(p, s); },
    }),
  };
  const Device = { screenSize: () => ({ width: 390, height: 844 }) };
  return { texts, keychain, files, requests, responses, __hypercool: null, Color, Size, Font, ListWidget: Stack, Request, Keychain, FileManager, Device, Date, JSON, Math, Number, String, Object, Array, console, encodeURIComponent, isNaN, setTimeout };
}

function load(): Sandbox & Record<string, unknown> {
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  // 스크립트는 최상위 await 를 쓰므로 async 함수로 감싼다. config 가 없으니 main() 은 돌지 않는다.
  vm.runInContext(`(async () => { ${source} \n})()`, sandbox);
  return sandbox;
}

const fsDoc = (fields: Record<string, unknown>) => ({
  document: {
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) }])),
  },
});

const today = new Date();
const ymd = (offset: number) => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('hypercool-widget.js', () => {
  let sb: ReturnType<typeof load>;
  beforeEach(() => { sb = load(); });

  it('decodes Firestore REST fields and derives kinds', () => {
    const { decodeFields, toEntry } = sb.__hypercool;
    const doc = decodeFields(fsDoc({ id: 'a', type: 'period_schedule', title: '중간고사', startDate: ymd(-1), endDate: ymd(3), isDeleted: false }).document.fields);
    expect(doc.isDeleted).toBe(false);
    expect(toEntry(doc).kind).toBe('period');
    expect(toEntry({ id: 'b', type: 'message_task', title: 'x', startDate: ymd(0), endDate: ymd(0) }).kind).toBe('message');
    expect(toEntry({ id: 'c', type: 'manual_todo', title: 'x', startDate: `${ymd(0)}T09:00:00`, isCompleted: true })).toMatchObject({ kind: 'todo', done: true });
    expect(toEntry({ id: 'd', type: 'period_schedule', title: 'x', startDate: ymd(0), endDate: ymd(0), isDeleted: true })).toBeNull();
  });

  it('entriesForDay orders period → event → todo and filters by day', () => {
    const { toEntry, entriesForDay } = sb.__hypercool;
    const entries = [
      toEntry({ id: 't', type: 'manual_todo', title: '할일', startDate: ymd(0), endDate: ymd(0) }),
      toEntry({ id: 'e', type: 'period_schedule', title: '회의', startDate: `${ymd(0)} 15:00:00`, endDate: `${ymd(0)} 16:00:00` }),
      toEntry({ id: 'p', type: 'period_schedule', title: '시험', startDate: ymd(-2), endDate: ymd(2) }),
      toEntry({ id: 'x', type: 'period_schedule', title: '내일', startDate: ymd(1), endDate: ymd(1) }),
    ];
    expect(entriesForDay(entries, today).map((e: any) => e.id)).toEqual(['p', 'e', 't']);
  });

  it('refreshes the id token, queries Firestore, caches, and renders titles', async () => {
    const { loadModel, buildWidget } = sb.__hypercool;
    sb.keychain.set('hypercool.refreshToken', 'RT');
    sb.responses.push(
      { id_token: 'ID', refresh_token: 'RT2', expires_in: '3600', user_id: 'uid-1' },
      [
        fsDoc({ id: 'a', type: 'period_schedule', title: '교직원 회의', startDate: `${ymd(0)}T15:00:00`, endDate: `${ymd(0)}T16:00:00`, isDeleted: false }),
        fsDoc({ id: 'b', type: 'manual_todo', title: '안내문 배부', startDate: ymd(0), endDate: ymd(0), isDeleted: false }),
        fsDoc({ id: 'c', type: 'period_schedule', title: '지워진 것', startDate: ymd(0), endDate: ymd(0), isDeleted: true }),
        { readTime: 'x' },
      ],
    );

    const model = await loadModel('medium');
    expect(model.error).toBeNull();
    expect(model.entries.map((e: any) => e.id)).toEqual(['a', 'b']);
    expect(sb.requests[0].url).toContain('securetoken.googleapis.com');
    expect(sb.requests[0].headers?.Referer).toBe('https://hypercool-fe1fa.web.app/');
    expect(sb.requests[1].url).toContain('/documents/users/uid-1:runQuery');
    expect(sb.requests[1].headers?.Authorization).toBe('Bearer ID');
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    const gridStartYmd = `${gridStart.getFullYear()}-${String(gridStart.getMonth() + 1).padStart(2, '0')}-${String(gridStart.getDate()).padStart(2, '0')}`;
    expect(JSON.parse(sb.requests[1].body!).structuredQuery.where.fieldFilter.value.stringValue).toBe(gridStartYmd);
    expect(sb.keychain.get('hypercool.refreshToken')).toBe('RT2');
    expect(sb.files.size).toBe(1);

    buildWidget(model);
    expect(sb.texts).toContain('교직원 회의');
    expect(sb.texts).toContain('안내문 배부');
    expect(sb.texts).toContain('2개');
    expect(sb.texts).toContain('15:00');
  });

  it('falls back to the cache when the network fails, and asks to connect when no token', async () => {
    const { loadModel, buildWidget } = sb.__hypercool;
    sb.keychain.set('hypercool.refreshToken', 'RT');
    sb.keychain.set('hypercool.idToken', 'ID');
    sb.keychain.set('hypercool.idTokenExp', String(Date.now() + 3_600_000));
    sb.keychain.set('hypercool.uid', 'uid-1');
    sb.responses.push([fsDoc({ id: 'a', type: 'period_schedule', title: '캐시된 일정', startDate: ymd(0), endDate: ymd(0), isDeleted: false })]);
    await loadModel('small');

    sb.responses.push(new Error('offline'));
    const stale = await loadModel('small');
    expect(stale.stale).toBe(true);
    expect(stale.entries[0].title).toBe('캐시된 일정');
    buildWidget(stale);
    expect(sb.texts).toContain('마지막 동기화 기준');

    sb.keychain.clear();
    const none = await loadModel('large');
    expect(none.error).toBe('NOT_CONNECTED');
    sb.texts.length = 0;
    buildWidget(none);
    expect(sb.texts).toContain('연결이 필요합니다');
  });

  it('large family renders the whole month grid and a today summary', async () => {
    const { toEntry, buildWidget } = sb.__hypercool;
    const entries = [
      toEntry({ id: 'n', type: 'period_schedule', title: '체육대회', startDate: ymd(3), endDate: ymd(3) }),
      toEntry({ id: 't', type: 'period_schedule', title: '교직원 회의', startDate: `${ymd(0)}T15:00:00`, endDate: `${ymd(0)}T16:00:00` }),
    ];
    buildWidget({ entries, family: 'large', stale: false, error: null });
    expect(sb.texts).toContain(`${today.getMonth() + 1}월`);
    expect(sb.texts).toContain(String(today.getFullYear()));
    for (const d of ['일', '월', '화', '수', '목', '금', '토']) expect(sb.texts).toContain(d);
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= lastDay; d++) expect(sb.texts).toContain(String(d));
    expect(sb.texts).toContain('오늘 1개');
    expect(sb.texts).toContain('교직원 회의');
    expect(sb.texts).toContain('체육대회'); // 칸마다 제목을 직접 쓴다
  });

  it('period titles appear once per span start (or Sunday), not on every day', () => {
    const { toEntry, buildWidget } = sb.__hypercool;
    // 이번 달 안에 4일짜리 기간 일정을 만들고, 그 주에 걸치는 날 수만큼만 제목이 나오는지 본다.
    const start = new Date(today.getFullYear(), today.getMonth(), 10);
    const end = new Date(today.getFullYear(), today.getMonth(), 13);
    const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const entries = [toEntry({ id: 'p', type: 'period_schedule', title: '중간고사', startDate: f(start), endDate: f(end) })];
    buildWidget({ entries, family: 'large', stale: false, error: null });
    let sundays = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) if (d.getDay() === 0 && d.getTime() !== start.getTime()) sundays++;
    expect(sb.texts.filter(x => x === '중간고사')).toHaveLength(1 + sundays);
  });

  it('extraLarge family writes titles into the cells', async () => {
    const { toEntry, buildWidget } = sb.__hypercool;
    const entries = [toEntry({ id: 'n', type: 'period_schedule', title: '체육대회', startDate: ymd(3), endDate: ymd(3) })];
    buildWidget({ entries, family: 'extraLarge', stale: false, error: null });
    expect(sb.texts).toContain('체육대회');
  });
});
