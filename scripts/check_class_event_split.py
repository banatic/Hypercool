"""슬롯 prefix(<eventIdx>*)가 반별로 다른 날(같은 학년 안에서 일부 반만 행사인 경우)이
실제로 있는지 확인. 헤더와 슬롯 prefix가 어긋나는 경우도 검사.
"""

import sys, io, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, 'scripts')

from datetime import timedelta
from verify_appin_parser import (
    DAT_PATH, load_dat, decrypt_text, decrypt_bytes,
    parse_subjects, parse_teachers, parse_classes, BASE_DATE,
)

records = load_dat(DAT_PATH)
classes = parse_classes(records)

# 행사 카탈로그
def parse_events(records):
    dec = decrypt_bytes(records[1])
    pos = dec.find(b' ')
    body = dec[pos+1:] if pos != -1 else dec
    text = body.decode('euc-kr', errors='replace')
    out = []
    for item in text.split(','):
        parts = item.split('^')
        out.append((parts[1] if len(parts) >= 2 else parts[0]).strip().rstrip('\x00'))
    return out

events = parse_events(records)

EVENT_RE = re.compile(r'^~?(\d+)\*')

# 반의 학년 추출
def class_grade(cn):
    m = re.match(r'(\d+)-', cn)
    return int(m.group(1)) if m else 0

per_class_diff = []
header_slot_mismatch = []

for ri in range(8, len(records)):
    offset = ri - 9
    d = BASE_DATE + timedelta(days=offset)
    if d.isoweekday() > 5:
        continue
    body = decrypt_text(records[ri])
    head, _, rest = body.partition('{')
    head_fields = head.split(',')
    if len(head_fields) < 4:
        continue
    try:
        hdr = [int(head_fields[i]) for i in (1, 2, 3)]
    except ValueError:
        continue

    # 본문에서 반별 슬롯 prefix 인덱스 집합 수집
    class_event_set = {}    # class_idx -> set of event indices found in slots
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
        evs = set()
        for pi in range(min(9, len(fields) - 2)):
            pd = fields[pi + 2]
            m = EVENT_RE.match(pd)
            if m:
                evs.add(int(m.group(1)))
        class_event_set[ci] = evs

    # 학년별로 슬롯 prefix 종류가 갈리는지 확인
    grade_map = {}  # grade -> set of slot event indices over all classes
    for ci, evs in class_event_set.items():
        g = class_grade(classes[ci-1])
        grade_map.setdefault(g, set()).update(evs)

    # 같은 학년 내에서 반마다 prefix가 다른 케이스
    grade_class_evs = {}  # grade -> {ci: evs}
    for ci, evs in class_event_set.items():
        g = class_grade(classes[ci-1])
        grade_class_evs.setdefault(g, {})[ci] = evs
    for g, m in grade_class_evs.items():
        evs_list = list(m.values())
        # 모든 반이 같은 단일-원소 집합이면 OK
        # 다르면 반별로 갈림
        first = evs_list[0] if evs_list else set()
        if not all(e == first for e in evs_list):
            per_class_diff.append((d, g, m))

    # 헤더와 슬롯 prefix가 어긋나는지
    for g_idx, hdr_ev in enumerate(hdr, start=1):
        slots_in_grade = grade_map.get(g_idx, set())
        if hdr_ev == 0:
            # 헤더는 행사 아님인데 슬롯에 prefix가 있으면 이상
            if slots_in_grade:
                header_slot_mismatch.append((d, g_idx, hdr_ev, slots_in_grade))
        else:
            # 헤더는 hdr_ev인데 슬롯엔 hdr_ev가 없거나 다른 게 있으면 이상
            if slots_in_grade and slots_in_grade != {hdr_ev}:
                header_slot_mismatch.append((d, g_idx, hdr_ev, slots_in_grade))

print(f"=== 같은 학년 내 반별 행사 분기 ({len(per_class_diff)}건) ===")
for d, g, m in per_class_diff:
    print(f"  {d} {g}학년:")
    for ci, evs in m.items():
        names = [events[e-1] if 1 <= e <= len(events) else f'?{e}' for e in evs]
        print(f"    {classes[ci-1]}: {evs} {names}")

print(f"\n=== 헤더 vs 슬롯 prefix 불일치 ({len(header_slot_mismatch)}건) ===")
for d, g, hdr, slots in header_slot_mismatch:
    hdr_name = events[hdr-1] if 1 <= hdr <= len(events) else ('-' if hdr == 0 else f'?{hdr}')
    slot_names = [events[e-1] if 1 <= e <= len(events) else f'?{e}' for e in slots]
    print(f"  {d} {g}학년: 헤더={hdr}({hdr_name}), 슬롯={slots} {slot_names}")
