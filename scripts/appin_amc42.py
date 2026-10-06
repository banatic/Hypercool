"""
압핀시간표(amc42.exe) 데이터 파일 amc42.dat 레퍼런스 디코더

포맷 명세: docs/appin_amc42_format.md
amc42.exe(Delphi) 의 로더/세이버/셀 파서·직렬화 루틴을 디스어셈블해 그대로 옮긴 구현이다.
--check 는 파싱 → exe 와 같은 규칙으로 재직렬화 → 재암호화한 결과가 원본 파일과
바이트 단위로 같은지 확인한다 (문법이 빠짐없이 해석됐다는 증거).

사용법:
  python scripts/appin_amc42.py --check
  python scripts/appin_amc42.py --json out.json
  python scripts/appin_amc42.py --day 2026-10-06 --class 2-1
"""

import argparse
import json
import sys
from dataclasses import dataclass, field, asdict
from datetime import date, timedelta

DAT_PATH = r"C:\Program Files (x86)\압핀시간표\amc42.dat"
XOR_KEY = b"7n1bmu"
BS = "\\"

EVENT_KINDS = {1: "행사(교과수업병행)", 2: "행사(교과수업안함)", 3: "고사(시험)",
               4: "휴가(방학)", 5: "공휴일/휴업"}
ABSENCE_KINDS = {1: "공결", 2: "사결"}


# ── 암호 ────────────────────────────────────────────────────────────────────
# 줄(CRLF 제외) 단위로 키 위치가 0 부터 다시 시작한다. 0x20 이하 바이트, 그리고
# XOR 결과가 0x20 이하가 되는 바이트는 평문 그대로 둔다 → 같은 함수가 암·복호화 겸용.

def xor_line(raw: bytes) -> bytes:
    out = bytearray(raw)
    for i, b in enumerate(raw):
        if b > 0x20:
            d = b ^ XOR_KEY[i % 6]
            if d > 0x20:
                out[i] = d
    return bytes(out)


# ── 셀 ─────────────────────────────────────────────────────────────────────

@dataclass
class Entry:
    """셀 안의 수업 1건 (분반이면 셀에 여러 건). 번호는 모두 1-based, 0 = 없음."""
    subject: int = 0
    subject_orig: int = 0     # 기초시간표 과목 ('원+새' 의 원)
    teacher: int = 0
    teacher_orig: int = 0     # 원래 교사 (보강/교체 전)
    room: int = 0             # #tbsnames 특별실
    room_orig: int = 0
    absence_reason: int = 0   # '#r' → #gbsynames 근무상황(결강 사유)
    absent_teacher: int = 0   # '#r(t' → 결강 교사


@dataclass
class Cell:
    block: int = 0            # 'N>' 선택과목 블록(군) 번호
    fixed: bool = False       # '~' 고정
    event: int = 0            # 'N*' #hensa 행사 번호
    entries: list = field(default_factory=list)
    origin: tuple = (0, 0)    # '<d.p' 원래 위치(일련일, 교시). 없으면 자기 자신
    extra_origins: list = field(default_factory=list)  # 추가 '<d.p' (최대 4)
    group: int = 0            # '|N' 동시수업 묶음 ID


def _orig_new(part: str):
    if "+" in part:
        o, n = part.split("+", 1)
        return int(n or 0), int(o or 0)
    v = int(part or 0)
    return v, v


def parse_cell(s: str, day: int, period: int) -> Cell:
    c = Cell(origin=(day, period))
    if ">" in s:
        a, s = s.split(">", 1)
        c.block = int(a) if a.isdigit() else 0
    if "~" in s:
        c.fixed = True
        s = s.replace("~", "", 1)
    if "*" in s:
        a, s = s.split("*", 1)
        c.event = int(a)
    if "|" in s:
        s, a = s.split("|", 1)
        c.group = int(a)
    if "<" in s:
        s, a = s.split("<", 1)
        parts = a.split("<")
        d, p = parts[0].split(".")
        c.origin = (int(d), int(p))
        c.extra_origins = [tuple(int(x) for x in q.split(".")) for q in parts[1:]]
    for es in s.split("/") if s else []:
        e = Entry()
        if BS in es:
            es, room = es.split(BS, 1)
            e.room, e.room_orig = _orig_new(room)
        if "#" in es:
            es, h = es.split("#", 1)
            if "(" in h:
                r, t = h.split("(", 1)
                e.absence_reason, e.absent_teacher = int(r or 0), int(t or 0)
            else:
                e.absence_reason = int(h or 0)
        sp, _, tp = es.partition("(")
        e.subject, e.subject_orig = _orig_new(sp)
        e.teacher, e.teacher_orig = _orig_new(tp)
        c.entries.append(e)
    return c


def _orig_new_str(new: int, orig: int) -> str:
    s = ""
    if orig != new:
        s += (str(orig) if orig > 0 else "") + "+"
    if new > 0:
        s += str(new)
    return s


def cell_to_str(c: Cell, day: int, period: int) -> str:
    """amc42.exe 0x12d83f0 과 같은 규칙."""
    s = f"{c.block}>" if c.block > 0 else ""
    if c.fixed:
        s += "~"
    if c.event:
        s += f"{c.event}*"
    parts = []
    for e in c.entries:
        p = _orig_new_str(e.subject, e.subject_orig) + "("
        p += _orig_new_str(e.teacher, e.teacher_orig)
        if e.absence_reason > 0:
            p += f"#{e.absence_reason}"
            if e.absent_teacher > 0:
                p += f"({e.absent_teacher}"
        if e.room > 0 or e.room_orig > 0:
            p += BS + _orig_new_str(e.room, e.room_orig)
        parts.append(p)
    s += "/".join(parts)
    od, op = c.origin
    if od and op:
        if (od, op) != (day, period) or c.extra_origins:
            s += f"<{od}.{op}"
        for d, p in c.extra_origins:
            s += f"<{d}.{p}"
    if c.group > 0:
        s += f"|{c.group}"
    return s


# ── 일별 레코드 ─────────────────────────────────────────────────────────────

@dataclass
class DayRecord:
    day: int                      # 일련일 (1 = 학년도 3월 1일)
    date: str
    header: list                  # '{' 앞 필드 전체 (원문)
    grade_events: list            # 헤더 2~4번째: 1·2·3학년 하루 전체 행사(#hensa 번호)
    rows: dict                    # 학반번호 → {"flag": int, "cells": {교시: Cell}}
    unassigned: list              # ':' 뒤 미배정 수업 (1일차 레코드에만 저장됨)


def parse_day(line: str, day_date: date) -> DayRecord:
    main, _, unas = line.partition(":")
    head, *secs = main.split("{")
    hf = head.split(",")
    dn = int(hf[0])
    rows = {}
    for sec in secs:
        f = sec.split(",")
        cls = int(f[0])
        cells = {}
        for p, cs in enumerate(f[2:11], 1):
            if cs:
                cells[p] = parse_cell(cs, dn, p)
        rows[cls] = {"flag": int(f[1] or 0), "cells": cells}
    unassigned = []
    for sec in unas.split("{")[1:] if unas else []:
        cls, _, cs = sec.partition(",")
        unassigned.append((int(cls), parse_cell(cs, 0, 0)))
    ge = [int(x) if x.isdigit() else 0 for x in hf[1:4]]
    return DayRecord(dn, day_date.isoformat(), hf, ge, rows, unassigned)


def day_to_str(r: DayRecord, n_classes: int) -> str:
    """amc42.exe 0x12d8d8c 과 같은 규칙."""
    s = ",".join(r.header)
    for cls in range(1, n_classes + 1):
        row = r.rows.get(cls, {"flag": 0, "cells": {}})
        s += "{" + f"{cls},{row['flag']}"
        for p in range(1, 10):
            c = row["cells"].get(p)
            s += "," + (cell_to_str(c, r.day, p) if c else "")
    if r.day == 1 and r.unassigned:
        s += ":" + "".join("{" + f"{cls}," + cell_to_str(c, 0, 0) for cls, c in r.unassigned)
    return s


# ── 헤더 레코드 ─────────────────────────────────────────────────────────────

def _body(line: str, tag: str) -> str:
    assert line.startswith(tag), (tag, line[:20])
    return line[len(tag) + 1:]


def parse_file(path: str = DAT_PATH) -> dict:
    raw = open(path, "rb").read()
    lines = [xor_line(x).decode("cp949") for x in raw.split(b"\r\n")]
    if lines and lines[-1] == "":
        lines.pop()

    year, sem2_serial, flag = _body(lines[0], "#hnd").split(",")
    year = int(year)
    start = date(year, 3, 1)
    end = date(year + 1, 3, 1) - timedelta(days=1)
    sem2 = date(1899, 12, 30) + timedelta(days=int(sem2_serial))

    def kind_list(b):
        return [{"kind": int(k), "name": n} for k, n in (x.split("^", 1) for x in b.split(","))] if b else []

    events = kind_list(_body(lines[1], "#hensa"))
    absences = kind_list(_body(lines[2], "#gbsynames"))

    subjects = []
    for x in _body(lines[3], "#sbjnames").split(","):
        name, _, tail = x.partition("^")
        subjects.append({"name": name, "classes": tail.split("^") if tail else []})

    teachers = []
    for x in _body(lines[4], "#tcrnames").split(","):
        name, _, code = x.partition("^")
        teachers.append({"name": name, "code": code})

    classes = []
    for x in _body(lines[5], "#clsnames").split(","):
        grade, rest = x.split("^", 1)
        head, _, studs = rest.partition("^")
        name, _, hr = head.partition("@")
        star = name.endswith("*")
        hr1, _, hr2 = hr.partition("/")
        students = []
        for st in studs.split("/") if studs else []:
            num, sname, ch = st.split("@")
            students.append({"no": int(num), "name": sname,
                             "blockRows": [int(v) for v in ch.split(":")]})
        classes.append({"grade": int(grade), "name": name.rstrip("*"), "star": star,
                        "homeroom1": hr1, "homeroom2": hr2, "students": students})

    rooms = _body(lines[6], "#tbsnames").split(",") if lines[6].startswith("#tbsnames") else []
    sjp_line = lines[7] if lines[7].startswith("#sjp") else None
    sjp = _body(sjp_line, "#sjp") if sjp_line else " " * 26364
    bell = {"firstStart": sjp[0:4], "lessonMin": int(sjp[4:6] or 0), "breakMin": int(sjp[6:8] or 0),
            "lunchAfter": int(sjp[8:9] or 0), "lunchMin": int(sjp[9:11] or 0),
            "lastPeriod": int(sjp[11:12] or 0)}

    first_day_line = 8 if sjp_line else 7
    n_days = (end - start).days + 1
    days = []
    for i, line in enumerate(lines[first_day_line:first_day_line + n_days]):
        r = parse_day(line, start + timedelta(days=i))
        assert r.day == i + 1, "일련일 불일치 (exe: '손상된 파일 입니다.')"
        days.append(r)

    def day_bells(n):
        blk = sjp[12 + (n - 1) * 72: 12 + n * 72]
        return {p + 1: (blk[p * 8:p * 8 + 4], blk[p * 8 + 4:p * 8 + 8])
                for p in range(9) if blk[p * 8:p * 8 + 8].strip()}

    return {"year": year, "start": start, "end": end, "semester2Start": sem2, "hndFlag": flag,
            "events": events, "absences": absences, "subjects": subjects, "teachers": teachers,
            "classes": classes, "rooms": rooms, "bell": bell, "sjp": sjp, "dayBells": day_bells,
            "days": days, "lines": lines, "raw": raw, "firstDayLine": first_day_line}


# ── 검증 ────────────────────────────────────────────────────────────────────

def check(db: dict) -> bool:
    ok = True
    lines, n_cls = db["lines"], len(db["classes"])
    cells = 0
    for i, r in enumerate(db["days"]):
        orig = lines[db["firstDayLine"] + i]
        again = day_to_str(r, n_cls)
        if again != orig:
            ok = False
            print(f"[불일치] 일련일 {r.day}\n  원본: {orig[:200]}\n  재생: {again[:200]}")
        cells += sum(len(row["cells"]) for row in r.rows.values())
    rebuilt = b"".join(xor_line(l.encode("cp949")) + b"\r\n" for l in lines)
    same = rebuilt == db["raw"]
    print(f"일별 레코드 {len(db['days'])}개 · 셀 {cells}개 재직렬화 {'일치' if ok else '불일치'}")
    print(f"파일 전체 재암호화 바이트 비교: {'일치' if same else '불일치'} ({len(db['raw'])} bytes)")
    return ok and same


# ── 출력 ────────────────────────────────────────────────────────────────────

def describe_cell(db, c: Cell, day: int, period: int) -> str:
    sub = lambda i: db["subjects"][i - 1]["name"] if i else "-"
    tch = lambda i: db["teachers"][i - 1]["name"] if i else "-"
    room = lambda i: db["rooms"][i - 1] if i else ""
    out = []
    if c.event:
        ev = db["events"][c.event - 1]
        out.append(f"[{ev['name']}/{EVENT_KINDS.get(ev['kind'], ev['kind'])}]")
    if c.fixed:
        out.append("[고정]")
    if c.block:
        out.append(f"[선택{c.block}군 #{c.group}]")
    for e in c.entries:
        s = sub(e.subject)
        if e.subject_orig != e.subject:
            s = f"{sub(e.subject_orig)}→{s}"
        t = tch(e.teacher)
        if e.teacher_orig != e.teacher:
            t = f"{tch(e.teacher_orig)}→{t}"
        if e.absence_reason:
            t += f"({tch(e.absent_teacher)} {db['absences'][e.absence_reason - 1]['name']})"
        r = room(e.room)
        out.append(f"{s}/{t}" + (f"@{r}" if r else ""))
    if c.origin != (day, period):
        od, op = c.origin
        out.append(f"(원래 {db['start'] + timedelta(days=od - 1)} {op}교시)")
    return " ".join(out)


def to_json(db: dict) -> dict:
    days = []
    for r in db["days"]:
        days.append({"day": r.day, "date": r.date, "header": r.header, "gradeEvents": r.grade_events,
                     "bells": db["dayBells"](r.day),
                     "rows": {db["classes"][k - 1]["name"]: {"flag": v["flag"],
                              "cells": {p: asdict(c) for p, c in v["cells"].items()}}
                              for k, v in r.rows.items()},
                     "unassigned": [(k, asdict(c)) for k, c in r.unassigned]})
    keep = ("year", "hndFlag", "events", "absences", "subjects", "teachers", "classes", "rooms", "bell")
    out = {k: db[k] for k in keep}
    out.update(start=db["start"].isoformat(), end=db["end"].isoformat(),
               semester2Start=db["semester2Start"].isoformat(), days=days)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default=DAT_PATH)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--day")
    ap.add_argument("--class", dest="cls")
    a = ap.parse_args()
    db = parse_file(a.path)
    print(f"{db['year']}학년도 {db['start']} ~ {db['end']} · 2학기 {db['semester2Start']} · "
          f"교사 {len(db['teachers'])} 과목 {len(db['subjects'])} 학반 {len(db['classes'])} 특별실 {len(db['rooms'])}")
    if a.check and not check(db):
        sys.exit(1)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(to_json(db), f, ensure_ascii=False, indent=1)
    if a.day:
        r = next(r for r in db["days"] if r.date == a.day)
        for k, row in r.rows.items():
            name = db["classes"][k - 1]["name"]
            if a.cls and name != a.cls:
                continue
            for p, c in sorted(row["cells"].items()):
                print(f"{name} {p}교시  {describe_cell(db, c, r.day, p)}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
