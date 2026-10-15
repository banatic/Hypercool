// HyperCool — iOS Scriptable 위젯
// 오늘의 일정·할 일을 Firestore 에서 읽어 홈 화면 위젯으로 보여 준다.
// 설치: 이 스크립트를 Scriptable 에 "HyperCool" 이름으로 저장한 뒤,
//       https://hypercool-fe1fa.web.app/widget 에서 "위젯 연결"을 누른다.

const API_KEY = 'AIzaSyCYbqMKKP2gAFYCmt8WWI03v1-XEU68Tm0';
const PROJECT_ID = 'hypercool-fe1fa';
const WEB_URL = 'https://hypercool-fe1fa.web.app';
const KEY_REFRESH = 'hypercool.refreshToken';
const KEY_ID = 'hypercool.idToken';
const KEY_ID_EXP = 'hypercool.idTokenExp';
const KEY_UID = 'hypercool.uid';
const CACHE_FILE = 'hypercool-widget-cache.json';

// ── 색 (웹 variables.css 와 동일) ──────────────────────────
const C = {
  paper: () => Color.dynamic(new Color('#ffffff'), new Color('#161c25')),
  ink: () => Color.dynamic(new Color('#17202a'), new Color('#eef2f7')),
  ink2: () => Color.dynamic(new Color('#4b5563'), new Color('#b6c0cd')),
  ink3: () => Color.dynamic(new Color('#8a94a3'), new Color('#7b8797')),
  line: () => Color.dynamic(new Color('#e6e8ec'), new Color('#26303d')),
  blue: () => Color.dynamic(new Color('#3b82f6'), new Color('#60a5fa')),
  kind: {
    event: () => Color.dynamic(new Color('#1d4ed8'), new Color('#93c5fd')),
    period: () => Color.dynamic(new Color('#0f766e'), new Color('#5eead4')),
    todo: () => Color.dynamic(new Color('#b45309'), new Color('#fcd34d')),
    message: () => Color.dynamic(new Color('#6d28d9'), new Color('#c4b5fd')),
  },
  tint: {
    event: () => Color.dynamic(new Color('#dbeafe'), new Color('#1c2f4d')),
    period: () => Color.dynamic(new Color('#ccfbf1'), new Color('#113632')),
    todo: () => Color.dynamic(new Color('#fef3c7'), new Color('#3b2f0d')),
    message: () => Color.dynamic(new Color('#ede9fe'), new Color('#2b2249')),
  },
};
const KIND_LABEL = { event: '일정', period: '기간', todo: '할 일', message: '메시지' };
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// ── 날짜 ─────────────────────────────────────────────────
function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hasClock = (d) => d.getHours() !== 0 || d.getMinutes() !== 0;

// ── Firestore 문서 → 항목 ─────────────────────────────────
function decodeValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = decodeValue(fields[k]);
  return out;
}

function toEntry(doc) {
  if (doc.isDeleted) return null;
  const start = parseDate(doc.startDate);
  if (!start) return null;
  const end = parseDate(doc.endDate) || start;
  const type = doc.type;
  let kind;
  if (type === 'manual_todo' || type === 'desktopcal_memo') kind = 'todo';
  else if (type === 'message_task') kind = 'message';
  else kind = startOfDay(start).getTime() !== startOfDay(end).getTime() ? 'period' : 'event';
  return {
    id: doc.id,
    kind,
    title: doc.title || '(제목 없음)',
    start,
    end: kind === 'todo' ? start : end,
    done: !!doc.isCompleted,
  };
}

// 하루치: 기간 → 일정/메시지 → 할 일. 같은 묶음 안은 시각순.
function entriesForDay(entries, day) {
  const t = startOfDay(day).getTime();
  const rank = { period: 0, event: 1, message: 1, todo: 2 };
  return entries
    .filter((e) => startOfDay(e.start).getTime() <= t && startOfDay(e.end).getTime() >= t)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.start - b.start);
}

// ── 인증 ─────────────────────────────────────────────────
function saveRefreshToken(token) {
  Keychain.set(KEY_REFRESH, token);
  if (Keychain.contains(KEY_ID_EXP)) Keychain.remove(KEY_ID_EXP);
}

async function getIdToken() {
  if (Keychain.contains(KEY_ID) && Keychain.contains(KEY_ID_EXP)) {
    const exp = Number(Keychain.get(KEY_ID_EXP));
    if (Date.now() < exp - 60_000) return { idToken: Keychain.get(KEY_ID), uid: Keychain.get(KEY_UID) };
  }
  if (!Keychain.contains(KEY_REFRESH)) throw new Error('NOT_CONNECTED');

  const req = new Request(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`);
  req.method = 'POST';
  // API 키가 웹사이트(리퍼러) 제한이라, 웹앱 주소를 Referer 로 보내야 통과한다.
  req.headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Referer: `${WEB_URL}/`,
    Origin: WEB_URL,
  };
  req.body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(Keychain.get(KEY_REFRESH))}`;
  const res = await req.loadJSON();
  if (!res.id_token) {
    const code = res.error && res.error.message;
    if (code === 'TOKEN_EXPIRED' || code === 'USER_DISABLED' || code === 'USER_NOT_FOUND' || code === 'INVALID_REFRESH_TOKEN') {
      Keychain.remove(KEY_REFRESH);
      throw new Error('NOT_CONNECTED');
    }
    throw new Error(`AUTH: ${code || 'unknown'}`);
  }
  Keychain.set(KEY_ID, res.id_token);
  Keychain.set(KEY_ID_EXP, String(Date.now() + Number(res.expires_in) * 1000));
  Keychain.set(KEY_UID, res.user_id);
  if (res.refresh_token) Keychain.set(KEY_REFRESH, res.refresh_token);
  return { idToken: res.id_token, uid: res.user_id };
}

// ── 데이터 ───────────────────────────────────────────────
async function fetchEntries() {
  const { idToken, uid } = await getIdToken();
  // 월간 격자(대형)까지 채우려면 이번 달 1일이 속한 주의 일요일부터 필요하다.
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const lower = new Date(first);
  lower.setDate(first.getDate() - first.getDay());

  const req = new Request(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}:runQuery`,
  );
  req.method = 'POST';
  req.headers = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json', Referer: `${WEB_URL}/` };
  req.body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'events' }],
      // 문자열 비교라 형식이 섞여도 날짜(YYYY-MM-DD) 하한으로 넉넉히 가져온 뒤 기기에서 거른다.
      where: {
        fieldFilter: { field: { fieldPath: 'endDate' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: ymd(lower) } },
      },
      orderBy: [{ field: { fieldPath: 'endDate' }, direction: 'ASCENDING' }],
      limit: 600,
    },
  });
  const rows = await req.loadJSON();
  if (!Array.isArray(rows)) {
    const msg = rows && rows.error && rows.error.message;
    throw new Error(`FIRESTORE: ${msg || 'unexpected response'}`);
  }
  return rows
    .filter((r) => r.document)
    .map((r) => toEntry(decodeFields(r.document.fields || {})))
    .filter(Boolean);
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.libraryDirectory(), CACHE_FILE);
}
function writeCache(entries) {
  try {
    FileManager.local().writeString(
      cachePath(),
      JSON.stringify({ at: Date.now(), entries: entries.map((e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() })) }),
    );
  } catch (e) { /* 캐시 실패는 무시 */ }
}
function readCache() {
  try {
    const fm = FileManager.local();
    if (!fm.fileExists(cachePath())) return null;
    const data = JSON.parse(fm.readString(cachePath()));
    return { at: data.at, entries: data.entries.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) })) };
  } catch (e) {
    return null;
  }
}

// ── 위젯 그리기 ───────────────────────────────────────────
function addDot(row, color, size = 7) {
  const dot = row.addStack();
  dot.size = new Size(size, size);
  dot.cornerRadius = size / 2;
  dot.backgroundColor = color;
  return dot;
}

function addEntryRow(stack, e, opts) {
  const { showKind = true, showTime = true, fontSize = 12 } = opts || {};
  const row = stack.addStack();
  row.centerAlignContent();
  row.spacing = 6;
  addDot(row, C.kind[e.kind](), 6);
  const title = row.addText(e.title);
  title.font = e.done ? Font.systemFont(fontSize) : Font.mediumSystemFont(fontSize);
  title.textColor = e.done ? C.ink3() : C.ink();
  title.lineLimit = 1;
  row.addSpacer();
  const tail = e.kind !== 'period' && showTime && hasClock(e.start)
    ? `${pad(e.start.getHours())}:${pad(e.start.getMinutes())}`
    : showKind ? KIND_LABEL[e.kind] : '';
  if (tail) {
    const t = row.addText(tail);
    t.font = Font.systemFont(fontSize - 1);
    t.textColor = C.ink3();
  }
  return row;
}

function addHeader(w, today, count, family) {
  const head = w.addStack();
  head.bottomAlignContent();
  const num = head.addText(String(today.getDate()));
  num.font = Font.boldSystemFont(family === 'small' ? 28 : 30);
  num.textColor = C.ink();
  head.addSpacer(6);
  const col = head.addStack();
  col.layoutVertically();
  const month = col.addText(`${today.getMonth() + 1}월`);
  month.font = Font.systemFont(11);
  month.textColor = C.ink3();
  const wd = col.addText(`${WEEKDAYS[today.getDay()]}요일`);
  wd.font = Font.semiboldSystemFont(12);
  wd.textColor = C.ink2();
  col.addSpacer(3);
  head.addSpacer();
  if (count > 0) {
    const badge = head.addStack();
    badge.setPadding(2, 7, 2, 7);
    badge.cornerRadius = 9;
    badge.backgroundColor = Color.dynamic(new Color('#e8f0fe'), new Color('#1a2a45'));
    const bt = badge.addText(`${count}개`);
    bt.font = Font.semiboldSystemFont(10);
    bt.textColor = Color.dynamic(new Color('#1d4ed8'), new Color('#93c5fd'));
  }
}

// 위젯 크기(pt) — Scriptable 은 크기를 알려주지 않아 기기 화면 크기별 표로 추정한다.
function widgetSize(family) {
  const sz = Device.screenSize();
  const sw = Math.min(sz.width, sz.height);
  const sh = Math.max(sz.width, sz.height);
  if (family === 'extraLarge') {
    if (sw >= 1024) return { w: 795, h: 405 };
    if (sw >= 820) return { w: 715, h: 360 };
    return { w: 634, h: 330 };
  }
  if (sw >= 428) return { w: 364, h: 382 };
  if (sw >= 414) return sh >= 896 ? { w: 360, h: 379 } : { w: 348, h: 357 };
  if (sw >= 390) return { w: 338, h: 354 };
  if (sw >= 375) return sh >= 812 ? { w: 329, h: 345 } : { w: 321, h: 324 };
  if (sw >= 360) return { w: 329, h: 345 };
  return { w: 292, h: 311 };
}

function addCentered(stack, build) {
  const row = stack.addStack();
  row.addSpacer();
  const out = build(row);
  row.addSpacer();
  return out;
}

// 대형·특대형: 월간 격자. 데스크톱 달력 위젯처럼 칸마다 일정 제목을 직접 쓴다.
// 세로 공간을 전부 격자에 배분하고, 일정이 적은 날은 제목을 두 줄로 써서 잘림을 줄인다.
function buildMonth(w, entries, family, today) {
  const PAD = 8;
  w.setPadding(PAD, PAD, PAD, PAD);
  const xl = family === 'extraLarge';
  const { w: W, h: H } = widgetSize(family);
  const cellW = Math.floor((W - PAD * 2) / 7);

  const year = today.getFullYear();
  const month = today.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const todayList = entriesForDay(entries, today);

  // 세로 배분: 머리글·요일 줄을 뺀 나머지를 주 수로 나눈다.
  const headH = xl ? 30 : 22;
  const wdH = xl ? 14 : 11;
  const gridH = H - PAD * 2 - headH - wdH - 5;
  const cellH = Math.floor(gridH / weeks);
  const numH = xl ? 15 : 12;
  const chipH = xl ? 13 : 10;
  const chipFont = xl ? 9 : 7;
  const numFont = xl ? 12 : 9;
  const GAP = 1;
  // 칸 안 고정 높이 예산: 패딩 2 + 숫자 줄 + 간격 1 + 칩 영역
  const chipArea = cellH - 2 - numH - GAP;
  const slots = Math.max(1, Math.floor((chipArea + GAP) / (chipH + GAP)));

  // 머리글
  const head = w.addStack();
  head.size = new Size(0, headH);
  head.bottomAlignContent();
  const mnum = head.addText(`${month + 1}월`);
  mnum.font = Font.boldSystemFont(xl ? 26 : 18);
  mnum.textColor = C.ink();
  head.addSpacer(5);
  const yr = head.addText(String(year));
  yr.font = Font.systemFont(xl ? 12 : 10);
  yr.textColor = C.ink3();
  head.addSpacer();
  const sum = head.addText(todayList.length ? `오늘 ${todayList.length}개` : '오늘 일정 없음');
  sum.font = Font.mediumSystemFont(xl ? 11 : 9);
  sum.textColor = todayList.length ? C.blue() : C.ink3();
  w.addSpacer(3);

  // 요일
  const wdRow = w.addStack();
  wdRow.addSpacer();
  WEEKDAYS.forEach((d, i) => {
    const c = wdRow.addStack();
    c.size = new Size(cellW, wdH);
    addCentered(c, (r) => {
      const t = r.addText(d);
      t.font = Font.semiboldSystemFont(xl ? 10 : 8);
      t.textColor = i === 0 ? new Color('#dc2626') : i === 6 ? new Color('#2563eb') : C.ink3();
      return t;
    });
  });
  wdRow.addSpacer();
  w.addSpacer(2);

  // 모든 칸의 내용 높이를 정확히 같게 만든다(빈 자리는 고정 높이 채움 스택).
  // 그래야 스택 정렬 방식과 무관하게 날짜 숫자가 매 칸 같은 높이에 온다.
  const cursor = new Date(gridStart);
  for (let wk = 0; wk < weeks; wk++) {
    const row = w.addStack();
    row.topAlignContent();
    row.addSpacer();
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor);
      const dow = d.getDay();
      const inMonth = d.getMonth() === month;
      const isToday = startOfDay(d).getTime() === startOfDay(today).getTime();
      const dayEntries = entriesForDay(entries, d);

      const cell = row.addStack();
      cell.layoutVertically();
      cell.size = new Size(cellW, cellH);
      cell.spacing = 0;
      cell.setPadding(1, 1, 1, 1);
      cell.url = `${WEB_URL}/calendar?date=${ymd(d)}`;
      if (isToday) {
        cell.cornerRadius = 4;
        cell.backgroundColor = Color.dynamic(new Color('#e8f0fe'), new Color('#1a2a45'));
      }
      const innerW = cellW - 2;

      // 날짜 숫자 — 고정 높이 줄, 왼쪽 정렬
      const numRow = cell.addStack();
      numRow.size = new Size(innerW, numH);
      numRow.setPadding(0, 2, 0, 0);
      numRow.centerAlignContent();
      const t = numRow.addText(String(d.getDate()));
      t.font = isToday ? Font.boldSystemFont(numFont) : Font.systemFont(numFont);
      t.textColor = !inMonth ? C.line()
        : isToday ? C.blue()
        : dow === 0 ? new Color('#dc2626')
        : dow === 6 ? new Color('#2563eb')
        : C.ink();
      numRow.addSpacer();
      cell.addSpacer(GAP);

      // 칩: 넘치면 마지막 자리에 "+N", 자리가 남고 항목이 적으면 두 줄로
      const shown = dayEntries.length > slots ? dayEntries.slice(0, slots - 1) : dayEntries;
      const overflow = dayEntries.length - shown.length;
      // 자리가 남으면 제목을 여러 줄(최대 3줄)로 써서 잘림을 줄인다
      const linesPer = shown.length > 0 && overflow === 0 ? Math.min(3, Math.floor(slots / shown.length)) : 1;
      let usedPx = 0;
      const addRow = (h) => {
        const r = cell.addStack();
        r.size = new Size(innerW, h);
        usedPx += h;
        return r;
      };
      const gapAfter = () => {
        cell.addSpacer(GAP);
        usedPx += GAP;
      };
      for (const e of shown) {
        const chip = addRow(chipH * linesPer + GAP * (linesPer - 1));
        chip.cornerRadius = 2;
        chip.backgroundColor = inMonth ? C.tint[e.kind]() : C.line();
        chip.centerAlignContent();
        chip.setPadding(0, 1, 0, 1);
        // 기간 일정은 시작일과 주의 첫날에만 글자를 쓰고, 나머지 날은 색 막대로 잇는다.
        const isSpanContinuation = e.kind === 'period' && startOfDay(e.start).getTime() !== startOfDay(d).getTime() && dow !== 0;
        if (!isSpanContinuation) {
          const ct = chip.addText(e.title);
          ct.font = Font.mediumSystemFont(chipFont);
          ct.textColor = inMonth ? C.kind[e.kind]() : C.ink3();
          ct.lineLimit = linesPer;
          ct.minimumScaleFactor = 0.75;
        }
        chip.addSpacer();
        gapAfter();
      }
      if (overflow > 0) {
        const more = addRow(chipH);
        more.centerAlignContent();
        more.setPadding(0, 2, 0, 0);
        const mt = more.addText(`+${overflow}`);
        mt.font = Font.systemFont(chipFont);
        mt.textColor = C.ink3();
        more.addSpacer();
        gapAfter();
      }
      // 남는 높이를 고정 채움으로 메워 내용 높이 = 칸 높이
      const filler = chipArea - usedPx;
      if (filler > 0) addRow(filler);

      cursor.setDate(cursor.getDate() + 1);
    }
    row.addSpacer();
  }
}

function buildWidget(model) {
  const { entries, family, stale, error } = model;
  const w = new ListWidget();
  w.backgroundColor = C.paper();
  w.url = `${WEB_URL}/today`;
  w.setPadding(14, 16, 12, 16);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  const today = new Date();
  const todayList = entriesForDay(entries, today);

  if (error === 'NOT_CONNECTED') {
    const t = w.addText('HyperCool');
    t.font = Font.boldSystemFont(14);
    t.textColor = C.ink();
    w.addSpacer(6);
    const s = w.addText('연결이 필요합니다');
    s.font = Font.systemFont(12);
    s.textColor = C.ink2();
    const u = w.addText(`${WEB_URL.replace('https://', '')}/widget`);
    u.font = Font.systemFont(11);
    u.textColor = C.blue();
    w.url = `${WEB_URL}/widget`;
    w.addSpacer();
    return w;
  }

  if (family === 'large' || family === 'extraLarge') {
    w.url = `${WEB_URL}/calendar`;
    buildMonth(w, entries, family, today);
  } else {
    addHeader(w, today, todayList.length, family);
    w.addSpacer(family === 'small' ? 8 : 10);
    const maxRows = family === 'small' ? 3 : 4;
    if (todayList.length === 0) {
      const t = w.addText('일정이 없습니다');
      t.font = Font.systemFont(12);
      t.textColor = C.ink3();
    } else {
      const list = w.addStack();
      list.layoutVertically();
      list.spacing = family === 'small' ? 4 : 6;
      for (const e of todayList.slice(0, maxRows)) {
        addEntryRow(list, e, { showKind: family !== 'small', showTime: family !== 'small', fontSize: family === 'small' ? 11 : 12 });
      }
      if (todayList.length > maxRows) {
        const more = w.addText(`+${todayList.length - maxRows}`);
        more.font = Font.systemFont(10);
        more.textColor = C.ink3();
      }
    }
  }

  w.addSpacer();
  if (stale || error) {
    const foot = w.addText(stale ? '마지막 동기화 기준' : `오류: ${error}`);
    foot.font = Font.systemFont(9);
    foot.textColor = C.ink3();
    foot.lineLimit = 1;
  }
  return w;
}

// ── 실행 ─────────────────────────────────────────────────
async function loadModel(family) {
  try {
    const entries = await fetchEntries();
    writeCache(entries);
    return { entries, family, stale: false, error: null };
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg === 'NOT_CONNECTED') return { entries: [], family, stale: false, error: 'NOT_CONNECTED' };
    const cached = readCache();
    if (cached) return { entries: cached.entries, family, stale: true, error: null };
    return { entries: [], family, stale: false, error: msg.slice(0, 60) };
  }
}

async function connectFromArgs() {
  const token = args && args.queryParameters && args.queryParameters.token;
  if (token) {
    saveRefreshToken(token);
    return true;
  }
  return false;
}

async function promptForToken() {
  const a = new Alert();
  a.title = 'HyperCool 연결';
  a.message = '웹의 iOS 위젯 페이지에서 복사한 토큰을 붙여넣으세요.';
  a.addTextField('토큰');
  a.addAction('저장');
  a.addCancelAction('취소');
  const idx = await a.present();
  if (idx === -1) return false;
  const token = a.textFieldValue(0).trim();
  if (!token) return false;
  saveRefreshToken(token);
  return true;
}

async function main() {
  const family = config.widgetFamily || 'medium';

  if (!config.runsInWidget) {
    const connected = await connectFromArgs();
    if (connected) {
      const done = new Alert();
      done.title = '연결되었습니다';
      done.message = '홈 화면에 Scriptable 위젯을 추가하고 스크립트로 HyperCool 을 고르세요.';
      done.addAction('확인');
      await done.present();
    } else if (!Keychain.contains(KEY_REFRESH)) {
      await promptForToken();
    }
  }

  const model = await loadModel(family);
  const w = buildWidget(model);
  if (config.runsInWidget) {
    Script.setWidget(w);
  } else {
    await (family === 'small' ? w.presentSmall() : family === 'large' ? w.presentLarge() : w.presentMedium());
  }
  Script.complete();
}

if (typeof config !== 'undefined') {
  await main();
} else if (typeof globalThis !== 'undefined') {
  // 테스트용 내보내기 (Scriptable 밖에서 실행될 때)
  globalThis.__hypercool = { parseDate, toEntry, entriesForDay, decodeFields, buildWidget, loadModel, KIND_LABEL };
}
