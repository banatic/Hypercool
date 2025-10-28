import sys
import os
import sqlite3


def print_schema(db_path: str) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.exists(db_path):
        print(f"[error] 파일을 찾을 수 없습니다: {db_path}")
        return 2

    try:
        conn = sqlite3.connect(db_path)
    except Exception as e:
        print(f"[error] DB 연결 실패: {e}")
        return 3

    try:
        cur = conn.cursor()

        print("== sqlite_master (tables/views) ==")
        cur.execute(
            "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
        )
        rows = cur.fetchall()
        if not rows:
            print("(no tables or views)")
        for name, obj_type, create_sql in rows:
            print(f"\n-- {obj_type.upper()}: {name}")
            if create_sql:
                print(create_sql)
            else:
                print("(no CREATE SQL)")

            if obj_type == "table":
                try:
                    cur.execute(f"PRAGMA table_info('{name}')")
                    cols = cur.fetchall()
                    print("columns:")
                    for cid, cname, ctype, notnull, dflt, pk in cols:
                        print(
                            f"  - {cname} {ctype or ''}"
                            f"{' NOT NULL' if notnull else ''}"
                            f"{' PRIMARY KEY' if pk else ''}"
                            f"{' DEFAULT ' + str(dflt) if dflt is not None else ''}"
                        )
                except Exception as e:
                    print(f"  [warn] PRAGMA table_info 실패: {e}")

        print("\n== indexes ==")
        try:
            cur.execute(
                "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY name"
            )
            for iname, tbl, isql in cur.fetchall():
                print(f"\n-- INDEX: {iname} ON {tbl}")
                print(isql or "(no CREATE SQL)")
        except Exception as e:
            print(f"[warn] 인덱스 조회 실패: {e}")

        print("\n== triggers ==")
        try:
            cur.execute(
                "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
            )
            for tname, tbl, tsql in cur.fetchall():
                print(f"\n-- TRIGGER: {tname} ON {tbl}")
                print(tsql or "(no CREATE SQL)")
        except Exception as e:
            print(f"[warn] 트리거 조회 실패: {e}")

        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main() -> int:
    if len(sys.argv) < 2:
        print("사용법: python scripts/inspect_udb.py <경로/파일.udb>")
        return 1
    db_path = sys.argv[1]
    return print_schema(db_path)


if __name__ == "__main__":
    raise SystemExit(main())


