"""헤더의 학년별 행사 인덱스(필드 2/3/4)가 실제로 학년마다 갈리는 날이 있는지 검사."""

import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, 'scripts')

from datetime import timedelta, date
from verify_appin_parser import (
    DAT_PATH, load_dat, decrypt_text, decrypt_bytes,
    parse_subjects, parse_teachers, parse_classes, BASE_DATE,
)

records = load_dat(DAT_PATH)
print(f"records: {len(records)}")

# 행사 카탈로그 파싱
def parse_events(records):
    dec = decrypt_bytes(records[1])
    pos = dec.find(b' ')
    body = dec[pos+1:] if pos != -1 else dec
    text = body.decode('euc-kr', errors='replace')
    events = []
    for item in text.split(','):
        parts = item.split('^')
        if len(parts) >= 2:
            events.append(parts[1].strip().rstrip('\x00'))
        else:
            events.append(parts[0].strip().rstrip('\x00'))
    return events

events = parse_events(records)
print(f"events: {len(events)}")
for i, e in enumerate(events, 1):
    print(f"  {i}: {e}")

print("\n=== 헤더의 학년별 행사 인덱스 검사 ===")
mixed = []
all_event_days = []

for ri in range(8, len(records)):
    offset = ri - 9
    d = BASE_DATE + timedelta(days=offset)
    if d.isoweekday() > 5:
        continue
    body = decrypt_text(records[ri])
    head = body.split('{', 1)[0]
    fields = head.split(',')
    if len(fields) < 4:
        continue
    try:
        g1 = int(fields[1])
        g2 = int(fields[2])
        g3 = int(fields[3])
    except ValueError:
        continue
    if g1 == 0 and g2 == 0 and g3 == 0:
        continue
    all_event_days.append((d, g1, g2, g3))
    if not (g1 == g2 == g3):
        mixed.append((d, g1, g2, g3))

print(f"\n총 행사일: {len(all_event_days)}")
for d, g1, g2, g3 in all_event_days:
    def name(i):
        return events[i-1] if 1 <= i <= len(events) else ('-' if i == 0 else f'?{i}')
    print(f"  {d} ({['월','화','수','목','금'][d.isoweekday()-1]}): "
          f"1학년={g1}({name(g1)}), 2학년={g2}({name(g2)}), 3학년={g3}({name(g3)})")

print(f"\n학년별로 다른 날: {len(mixed)}")
if mixed:
    for d, g1, g2, g3 in mixed:
        print(f"  {d}: g1={g1}, g2={g2}, g3={g3}")
else:
    print("  (없음 - 모든 행사일은 1·2·3학년이 동일)")
