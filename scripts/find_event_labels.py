"""Decrypt amc42.dat records 0..9 and dump anything that contains the literal
strings 어린이날 / 현장체험학습 — to find where the event labels are stored."""

import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from verify_appin_parser import (
    DAT_PATH, load_dat, decrypt_bytes, decrypt_text,
    parse_subjects, parse_teachers, parse_classes, BASE_DATE,
)
from datetime import timedelta

records = load_dat(DAT_PATH)
print(f"records: {len(records)}")

NEEDLES = ['어린이날', '현장체험', '체험학습', '재량휴업', '운동회', '스승의']

def scan_record(idx, raw):
    dec = decrypt_bytes(raw)
    # Try euc-kr first, then utf-8
    for enc in ('euc-kr', 'utf-8', 'cp949'):
        try:
            text = dec.decode(enc, errors='strict')
            for needle in NEEDLES:
                if needle in text:
                    pos = text.index(needle)
                    snippet = text[max(0, pos-40):pos+80]
                    print(f"  rec {idx} [{enc}] -> {needle!r}: ...{snippet!r}")
            return
        except UnicodeDecodeError:
            continue
    # Fallback - replace
    text = dec.decode('euc-kr', errors='replace')
    for needle in NEEDLES:
        if needle in text:
            pos = text.index(needle)
            snippet = text[max(0, pos-40):pos+80]
            print(f"  rec {idx} [euc-kr replace] -> {needle!r}: ...{snippet!r}")

print("\n=== scanning all records for event labels ===")
for i, r in enumerate(records):
    scan_record(i, r)

print("\n=== records 0..9 raw decoded preview ===")
for i in range(min(10, len(records))):
    dec = decrypt_bytes(records[i])
    try:
        text = dec.decode('euc-kr', errors='replace')
    except Exception:
        text = dec.decode('utf-8', errors='replace')
    print(f"\n--- record {i} (len={len(dec)}) ---")
    print(text[:600])
