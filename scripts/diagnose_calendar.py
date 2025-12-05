import sqlite3
import os
import sys
from collections import defaultdict

DB_PATH = os.path.expanduser(r'C:\Users\user\AppData\Roaming\com.hypercool.app\hypercool.db')

def diagnose():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at: {DB_PATH}")
        return

    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()

        print("--- Checking Message Tasks Content ---")
        cursor.execute("SELECT id, title, content, reference_id FROM tbl_schedules WHERE type = 'message_task' AND is_deleted = 0 LIMIT 20")
        rows = cursor.fetchall()
        empty_content_count = 0
        for row in rows:
            content = row[2]
            if not content or content.strip() == "":
                empty_content_count += 1
                print(f"WARNING: Message Task '{row[1]}' (Ref: {row[3]}) has EMPTY content.")
            else:
                # print(f"OK: Message Task '{row[1]}' has content (len {len(content)})")
                pass
        
        if empty_content_count > 0:
            print(f"\nFound {empty_content_count} message tasks with empty content (in first 20).")
        else:
            print("\nAll checked message tasks have content.")

        print("\n--- Checking Cross-Type Duplicates (Todo vs Schedule) ---")
        cursor.execute("SELECT type, title, start_date FROM tbl_schedules WHERE is_deleted = 0")
        all_rows = cursor.fetchall()
        
        # Group by (title, start_date)
        grouped = defaultdict(set)
        for row in all_rows:
            key = (row[1], row[2]) # title, start_date
            grouped[key].add(row[0]) # Add type
            
        duplicates = []
        for key, types in grouped.items():
            if len(types) > 1:
                duplicates.append((key, types))
                
        if duplicates:
            print(f"Found {len(duplicates)} items appearing as multiple types:")
            for d in duplicates[:10]:
                print(f"  {d[0]}: {d[1]}")
        else:
            print("No cross-type duplicates found.")

        conn.close()

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    diagnose()
