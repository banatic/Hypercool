"""
압핀시간표 amc42.dat 파서 검증 스크립트

사용법:
  python scripts/verify_appin_parser.py
  python scripts/verify_appin_parser.py --teacher 하혜경
  python scripts/verify_appin_parser.py --teacher 하혜경 --date 2026-03-31
  python scripts/verify_appin_parser.py --raw --date 2026-03-31 --period 5

옵션:
  --teacher NAME   특정 선생님의 시간표만 출력
  --date YYYY-MM-DD  특정 날짜만 출력
  --period N       특정 교시만 출력
  --raw            raw period 필드 원본 출력 (파싱 전 바이트 확인용)
  --swap-mode both|before|after
                   > 기호 처리 방식 비교
                   both   = before와 after 결과를 모두 출력 (기본값)
                   before = > 앞부분 사용 (현재 후보: 교환 수업 시 올바를 가능성)
                   after  = > 뒷부분 사용 (현재 Rust 코드 동작)
"""

import sys
import os
import argparse
from datetime import date, timedelta

DAT_PATH = r"C:\Program Files (x86)\압핀시간표\amc42.dat"
XOR_KEY = b"7n1bmu"
BASE_DATE = date(2026, 3, 2)


def parse_events(records):
    """record 1 (#hensa) → 1-based 행사명 카탈로그"""
    if len(records) < 2:
        return []
    dec = decrypt_bytes(records[1])
    pos = dec.find(b' ')
    body = dec[pos+1:] if pos != -1 else dec
    text = body.decode('euc-kr', errors='replace')
    out = []
    for item in text.split(','):
        parts = item.split('^')
        name = parts[1] if len(parts) >= 2 else parts[0]
        out.append(name.strip().rstrip('\x00').rstrip('\x06'))
    return out


def parse_header_events(body_text: str):
    """일별 레코드 헤더의 학년별 행사 인덱스 (1·2·3학년)"""
    head = body_text.split('{', 1)[0]
    fields = head.split(',')
    out = [None, None, None]
    for i in range(3):
        if i + 1 < len(fields):
            try:
                v = int(fields[i + 1])
                if v > 0:
                    out[i] = v
            except ValueError:
                pass
    return out


# ── 복호화 ──────────────────────────────────────────────────────────────────

def decrypt_bytes(raw: bytes) -> bytes:
    result = bytearray()
    for i, b in enumerate(raw):
        if b > 0x20:
            dec = b ^ XOR_KEY[i % 6]
            result.append(dec if dec > 0x20 else b)
        else:
            result.append(b)
    return bytes(result)


def decrypt_text(raw: bytes) -> str:
    return decrypt_bytes(raw).decode("utf-8", errors="replace")


def decode_euc_kr(raw: bytes) -> str:
    try:
        return raw.decode("euc-kr").strip("\x00\x06")
    except Exception:
        return raw.decode("utf-8", errors="replace").strip("\x00\x06")


# ── .dat 로드 ────────────────────────────────────────────────────────────────

def load_dat(path: str) -> list[bytes]:
    with open(path, "rb") as f:
        content = f.read()
    records = []
    current = bytearray()
    i = 0
    while i < len(content):
        if i + 1 < len(content) and content[i] == 0x0D and content[i+1] == 0x0A:
            records.append(bytes(current))
            current = bytearray()
            i += 2
        else:
            current.append(content[i])
            i += 1
    records.append(bytes(current))
    return records


# ── 메타 파싱 ────────────────────────────────────────────────────────────────

def parse_meta(rec: bytes) -> bytes:
    pos = rec.find(b' ')
    return rec[pos+1:] if pos != -1 else rec


def parse_subjects(records: list[bytes]) -> list[str]:
    dec = decrypt_bytes(records[3])
    body = parse_meta(dec)
    subjects = []
    for item in body.split(b','):
        pos = item.find(b'^')
        if pos != -1:
            name = decode_euc_kr(item[:pos])
            subjects.append(name if name else f"(S{len(subjects)})")
        else:
            subjects.append(decode_euc_kr(item).replace('\x00', ''))
    return subjects


def parse_teachers(records: list[bytes]) -> list[str]:
    dec = decrypt_bytes(records[4])
    body = parse_meta(dec)
    teachers = []
    for item in body.split(b','):
        pos = item.find(b'^')
        if pos != -1:
            name = decode_euc_kr(item[:pos]).replace('\x00', '')
            teachers.append(name)
    return teachers


def parse_classes(records: list[bytes]) -> list[str]:
    dec = decrypt_bytes(records[5])
    body = parse_meta(dec)
    body_str = decode_euc_kr(body)
    classes = []
    for item in body_str.split(','):
        parts = item.split('^')
        if len(parts) > 1:
            class_part = parts[1].split('@')[0].strip()
            if class_part:
                classes.append(class_part)
    return classes


# ── 교시 슬롯 파싱 ───────────────────────────────────────────────────────────

def _leading_int(s: str):
    digits = ''
    for c in s:
        if c.isdigit():
            digits += c
        else:
            break
    return int(digits) if digits else None


def parse_slot(pd_str: str, gt_mode: str) -> dict:
    """
    pd_str : 교시 필드 원본 문자열
    gt_mode: 'before' | 'after'  (> 기호 처리 방식)
    반환: {'subject': int|None, 'teacher': int|None, 'room': int|None, 'event': int|None, '_raw': str}
    """
    slot = {'subject': None, 'teacher': None, 'room': None, 'event': None, '_raw': pd_str}

    core = pd_str.split('|')[0]  # | 앞부분만
    if '>' in core:
        parts = core.split('>', 1)
        core = parts[0] if gt_mode == 'before' else parts[1]

    core = core.strip()
    if not core:
        return slot

    # <eventIdx>* 또는 ~<eventIdx>* prefix → 행사 슬롯으로 분류
    probe = core[1:] if core.startswith('~') else core
    ev = _leading_int(probe)
    if ev is not None and ev > 0:
        rest = probe[len(str(ev)):]
        if rest.startswith('*'):
            slot['event'] = ev
            return slot

    if '(' in core:
        sp = core.split('(', 1)
        subj_part = sp[0]
        rest_part = sp[1] if len(sp) > 1 else ''
        try:
            v = int(subj_part)
            if v > 0:
                slot['subject'] = v - 1
        except ValueError:
            pass
        if '\\' in rest_part:
            rp = rest_part.split('\\', 1)
            try:
                v = int(rp[0])
                if v > 0:
                    slot['teacher'] = v - 1
            except ValueError:
                pass
            try:
                v = int(rp[1].rstrip(')'))
                if v > 0:
                    slot['room'] = v - 1
            except ValueError:
                pass
        else:
            rest_clean = rest_part.rstrip(')')
            try:
                v = int(rest_clean)
                if v > 0:
                    slot['teacher'] = v - 1
            except ValueError:
                pass
    else:
        try:
            v = int(core)
            if v > 0:
                slot['subject'] = v - 1
        except ValueError:
            pass

    return slot


def parse_daily(body_text: str, gt_mode: str) -> dict:
    """반환: {class_idx: {'periods': {period: slot}, 'event': int|None}}"""
    tt = {}
    for sec in body_text.split('{')[1:]:
        fields = sec.split(',')
        if len(fields) < 3:
            continue
        try:
            cls = int(fields[0])
        except ValueError:
            continue
        periods = {}
        event_counts = {}
        max_p = min(9, len(fields) - 2)
        for pi in range(max_p):
            pd_str = fields[pi + 2]
            if not pd_str.strip():
                continue
            slot = parse_slot(pd_str, gt_mode)
            if slot['event'] is not None:
                event_counts[slot['event']] = event_counts.get(slot['event'], 0) + 1
                continue
            if slot['subject'] is not None or slot['teacher'] is not None or slot['room'] is not None:
                periods[pi + 1] = slot
        ev = max(event_counts, key=event_counts.get) if event_counts else None
        tt[cls] = {'periods': periods, 'event': ev}
    return tt


# ── 선생님 시간표 구축 ────────────────────────────────────────────────────────

def build_teacher_map(records, subjects, teachers, classes, gt_mode):
    """
    반환:
      teacher_map: {teacher_name: {date_str: {period: {subject_name, class_name}}}}
      events_by_date_class: {date_str: {class_name: event_label}}
      events_by_date_grade: {date_str: [g1, g2, g3]}
    """
    events = parse_events(records)
    def event_label(idx_1based):
        if idx_1based is None or idx_1based <= 0 or idx_1based > len(events):
            return None
        name = events[idx_1based - 1].strip()
        return name if name else None

    result = {t: {} for t in teachers}
    events_by_date_class = {}
    events_by_date_grade = {}

    for ri in range(8, len(records)):
        offset = ri - 9
        d = BASE_DATE + timedelta(days=offset)
        if d.isoweekday() > 5:
            continue
        body = decrypt_text(records[ri])
        header_evs = parse_header_events(body)
        tt = parse_daily(body, gt_mode)
        date_str = d.strftime("%Y-%m-%d")

        # 학년별 행사
        grade_labels = [event_label(e) for e in header_evs]
        if any(grade_labels):
            events_by_date_grade[date_str] = grade_labels

        # 반별 행사
        for ci, info in tt.items():
            if ci == 0 or ci > len(classes):
                continue
            class_name = classes[ci - 1]
            ev = info.get('event')
            label = event_label(ev)
            if label:
                events_by_date_class.setdefault(date_str, {})[class_name] = label
            for p, slot in info['periods'].items():
                t_idx = slot['teacher']
                s_idx = slot['subject']
                if t_idx is None or s_idx is None:
                    continue
                if t_idx >= len(teachers) or s_idx >= len(subjects):
                    continue
                t_name = teachers[t_idx]
                s_name = subjects[s_idx]
                result.setdefault(t_name, {}).setdefault(date_str, {})[p] = {
                    'subject': s_name,
                    'class': class_name,
                }
    return result, events_by_date_class, events_by_date_grade


# ── 출력 헬퍼 ────────────────────────────────────────────────────────────────

WEEKDAY_KR = ['월', '화', '수', '목', '금']


def print_teacher_schedule(teacher_map, teacher_name, filter_date=None, filter_period=None,
                           events_by_date_class=None, events_by_date_grade=None):
    events_by_date_class = events_by_date_class or {}
    events_by_date_grade = events_by_date_grade or {}
    data = teacher_map.get(teacher_name) or {}

    # 보여줄 날짜 = 교사 데이터가 있는 날 ∪ 행사일
    all_dates = set(data.keys()) | set(events_by_date_class.keys()) | set(events_by_date_grade.keys())
    if filter_date:
        all_dates &= {filter_date}
    if not all_dates:
        print(f"  [{teacher_name}] 데이터 없음")
        return

    for ds in sorted(all_dates):
        d = date.fromisoformat(ds)
        wd = WEEKDAY_KR[d.isoweekday() - 1]
        periods = data.get(ds, {})
        rows = sorted(periods.items())
        if filter_period:
            rows = [(p, v) for p, v in rows if p == filter_period]
        ev_class_map = events_by_date_class.get(ds, {})
        ev_grade_arr = events_by_date_grade.get(ds, [])

        # 행사 라벨 요약
        header_bits = []
        if ev_class_map:
            uniq = set(ev_class_map.values())
            header_bits.append(f"행사(반): {sorted(uniq)}")
        if any(ev_grade_arr):
            header_bits.append(f"행사(학년): {ev_grade_arr}")

        if not rows and not header_bits:
            continue
        print(f"  {ds} ({wd})  " + ("  ".join(header_bits) if header_bits else ""))
        for p, v in rows:
            label = ev_class_map.get(v['class'])
            if not label:
                m = v['class'].split('-')
                if m and m[0].isdigit():
                    g = int(m[0])
                    if 1 <= g <= len(ev_grade_arr):
                        label = ev_grade_arr[g - 1]
            tail = f"  ◀ 행사: {label}" if label else ""
            print(f"    {p}교시: {v['subject']} / {v['class']}{tail}")


def print_raw_slots(records, subjects, teachers, classes,
                    filter_date=None, filter_period=None):
    """raw 필드 원본 출력"""
    for ri in range(8, len(records)):
        offset = ri - 9
        d = BASE_DATE + timedelta(days=offset)
        if d.isoweekday() > 5:
            continue
        date_str = d.strftime("%Y-%m-%d")
        if filter_date and date_str != filter_date:
            continue

        body = decrypt_text(records[ri])
        for sec in body.split('{')[1:]:
            fields = sec.split(',')
            if len(fields) < 3:
                continue
            try:
                ci = int(fields[0])
            except ValueError:
                continue
            if ci == 0 or ci > len(classes):
                continue
            class_name = classes[ci - 1]
            max_p = min(9, len(fields) - 2)
            for pi in range(max_p):
                p = pi + 1
                if filter_period and p != filter_period:
                    continue
                pd_str = fields[pi + 2].strip()
                if not pd_str:
                    continue
                # before/after 둘 다 파싱
                s_before = parse_slot(pd_str, 'before')
                s_after  = parse_slot(pd_str, 'after')

                t_before = teachers[s_before['teacher']] if s_before['teacher'] is not None and s_before['teacher'] < len(teachers) else None
                t_after  = teachers[s_after['teacher']]  if s_after['teacher']  is not None and s_after['teacher']  < len(teachers) else None
                subj_before = subjects[s_before['subject']] if s_before['subject'] is not None and s_before['subject'] < len(subjects) else None
                subj_after  = subjects[s_after['subject']]  if s_after['subject']  is not None and s_after['subject']  < len(subjects) else None

                mark = ' ◀ differs' if '>' in pd_str else ''
                print(f"  {date_str} p{p} | 반:{class_name} | raw: {pd_str!r}{mark}")
                if '>' in pd_str:
                    print(f"         before(>앞): teacher={t_before} subject={subj_before}")
                    print(f"         after (>뒤): teacher={t_after}  subject={subj_after}")


# ── 메인 ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="압핀 파서 검증")
    parser.add_argument('--teacher', type=str, default=None)
    parser.add_argument('--date',    type=str, default=None)
    parser.add_argument('--period',  type=int, default=None)
    parser.add_argument('--raw',     action='store_true')
    parser.add_argument('--swap-mode', choices=['both', 'before', 'after'], default='both')
    args = parser.parse_args()

    if not os.path.exists(DAT_PATH):
        print(f"파일 없음: {DAT_PATH}")
        sys.exit(1)

    print(f"로딩: {DAT_PATH}")
    records = load_dat(DAT_PATH)
    subjects = parse_subjects(records)
    teachers = parse_teachers(records)
    classes  = parse_classes(records)
    print(f"선생님 {len(teachers)}명 / 과목 {len(subjects)}개 / 반 {len(classes)}개 / 레코드 {len(records)}개\n")

    if args.teacher:
        t_idx = next((i for i, t in enumerate(teachers) if t == args.teacher), None)
        if t_idx is None:
            # 부분 검색
            matches = [t for t in teachers if args.teacher in t]
            if matches:
                print(f"정확히 일치하는 선생님 없음. 유사: {matches}")
            else:
                print(f"선생님 '{args.teacher}' 없음")
            sys.exit(1)
        print(f"선생님: {args.teacher} (index={t_idx})")

    # raw 모드
    if args.raw:
        filter_p = args.period
        filter_d = args.date
        print(f"=== RAW 슬롯 (date={filter_d}, period={filter_p}) ===")
        print_raw_slots(records, subjects, teachers, classes, filter_d, filter_p)
        return

    # 비교 모드
    modes = ['before', 'after'] if args.swap_mode == 'both' else [args.swap_mode]
    bundles = {m: build_teacher_map(records, subjects, teachers, classes, m) for m in modes}

    def show(m, t, fd, fp):
        tm, ec, eg = bundles[m]
        print_teacher_schedule(tm, t, fd, fp, ec, eg)

    if args.swap_mode == 'both' and args.teacher:
        print("─── > 앞부분 사용 (before) ───────────────────────")
        show('before', args.teacher, args.date, args.period)
        print("\n─── > 뒷부분 사용 (after, 현재 Rust 코드) ────────")
        show('after', args.teacher, args.date, args.period)
    elif args.teacher:
        m = modes[0]
        print(f"=== {args.teacher} [{m}] ===")
        show(m, args.teacher, args.date, args.period)
    else:
        # 전체 선생님 비교 — 차이나는 날짜/교시만 출력
        if args.swap_mode == 'both':
            print("=== before vs after 차이 목록 ===")
            diffs = []
            tm_b = bundles['before'][0]
            tm_a = bundles['after'][0]
            for t in teachers:
                d_before = tm_b.get(t, {})
                d_after  = tm_a.get(t, {})
                all_dates = set(d_before) | set(d_after)
                for ds in sorted(all_dates):
                    p_before = d_before.get(ds, {})
                    p_after  = d_after.get(ds, {})
                    all_p = set(p_before) | set(p_after)
                    for p in sorted(all_p):
                        b = p_before.get(p)
                        a = p_after.get(p)
                        if b != a:
                            diffs.append((t, ds, p, b, a))
            if not diffs:
                print("  차이 없음 (모든 before == after)")
            for t, ds, p, b, a in diffs:
                d = date.fromisoformat(ds)
                wd = WEEKDAY_KR[d.isoweekday() - 1]
                print(f"  {t} | {ds}({wd}) {p}교시")
                print(f"    before: {b}")
                print(f"    after:  {a}")
        else:
            for t in (teachers[:10]):
                m = modes[0]
                data = bundles[m][0].get(t, {})
                if data:
                    print(f"\n=== {t} ===")
                    show(m, t, None, None)


if __name__ == '__main__':
    main()
