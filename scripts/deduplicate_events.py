import sqlite3
import os
import sys
import json
from collections import defaultdict

# --- Configuration ---
DB_PATH = os.path.expanduser(r'C:\Users\user\AppData\Roaming\com.hypercool.app\hypercool.db')

def deduplicate_sqlite():
    print(f"--- Deduplicating SQLite Database: {DB_PATH} ---")
    if not os.path.exists(DB_PATH):
        print(f"Database not found at: {DB_PATH}")
        return

    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()

        # Fetch all schedules
        cursor.execute("SELECT id, type, title, start_date, end_date, content, created_at FROM tbl_schedules WHERE is_deleted = 0")
        rows = cursor.fetchall()
        
        print(f"Total active items in DB: {len(rows)}")

        # Group by unique key: (type, title, start_date)
        # We can also include content if needed, but title+date+type is usually enough for duplicates
        grouped = defaultdict(list)
        for row in rows:
            # row: 0=id, 1=type, 2=title, 3=start_date, 4=end_date, 5=content, 6=created_at
            key = (row[1], row[2], row[3]) 
            grouped[key].append(row)

        duplicates_removed = 0
        
        for key, items in grouped.items():
            if len(items) > 1:
                print(f"Found {len(items)} duplicates for: {key}")
                # Sort by created_at (keep the oldest? or newest? usually keep the one with most info or just one)
                # Let's keep the one with the latest created_at as it might be the most recent sync
                # Actually, if they are identical, it doesn't matter.
                # Let's sort by created_at descending
                items.sort(key=lambda x: x[6], reverse=True)
                
                # Keep the first one, delete the rest
                to_keep = items[0]
                to_delete = items[1:]
                
                for item in to_delete:
                    print(f"  Deleting duplicate ID: {item[0]}")
                    cursor.execute("UPDATE tbl_schedules SET is_deleted = 1 WHERE id = ?", (item[0],))
                    duplicates_removed += 1

        conn.commit()
        conn.close()
        print(f"SQLite Deduplication Complete. Removed {duplicates_removed} duplicates.")

    except Exception as e:
        print(f"Error processing SQLite: {e}")

def deduplicate_firebase():
    print("\n--- Deduplicating Firebase Firestore ---")
    print("To deduplicate Firebase, we need to use the Admin SDK.")
    print("Please ensure you have a service account key JSON file.")
    
    key_path = input("Enter path to serviceAccountKey.json (or press Enter to skip Firebase): ").strip()
    if not key_path:
        print("Skipping Firebase deduplication.")
        return

    if not os.path.exists(key_path):
        print("File not found.")
        return

    try:
        import firebase_admin
        from firebase_admin import credentials
        from firebase_admin import firestore

        cred = credentials.Certificate(key_path)
        try:
            firebase_admin.initialize_app(cred)
        except ValueError:
            # Already initialized
            pass

        db = firestore.client()
        
        # We need the UID. Since this is a script, we might need to ask for it or scan all users.
        # Scanning all users is dangerous/slow if many users.
        # Let's ask for UID or try to find it from a local config if possible.
        # For now, let's ask.
        uid = input("Enter the Firebase User UID to clean up: ").strip()
        if not uid:
            print("UID required. Skipping.")
            return

        events_ref = db.collection('users').document(uid).collection('events')
        docs = events_ref.stream()
        
        all_events = []
        for doc in docs:
            data = doc.to_dict()
            data['id'] = doc.id
            all_events.append(data)
            
        print(f"Total events in Firestore for user {uid}: {len(all_events)}")
        
        # Group duplicates
        grouped = defaultdict(list)
        for event in all_events:
            # Key: type, title, startDate
            # Note: Firestore keys might differ slightly (startDate vs start_date), check your data model
            # Based on previous context, it's likely 'startDate' in Firestore
            
            # Helper to get value safely
            etype = event.get('type') or event.get('schedule_type')
            title = event.get('title')
            start = event.get('startDate') or event.get('start_date')
            
            if etype and title:
                key = (etype, title, start)
                grouped[key].append(event)
        
        duplicates_removed = 0
        batch = db.batch()
        batch_count = 0
        
        for key, items in grouped.items():
            if len(items) > 1:
                print(f"Found {len(items)} duplicates for: {key}")
                # Sort by createdAt if available
                # items.sort(key=lambda x: x.get('createdAt', ''), reverse=True)
                
                # Keep first
                to_delete = items[1:]
                for item in to_delete:
                    print(f"  Deleting Firestore ID: {item['id']}")
                    doc_ref = events_ref.document(item['id'])
                    batch.delete(doc_ref)
                    duplicates_removed += 1
                    batch_count += 1
                    
                    if batch_count >= 400:
                        batch.commit()
                        batch = db.batch()
                        batch_count = 0
        
        if batch_count > 0:
            batch.commit()
            
        print(f"Firebase Deduplication Complete. Removed {duplicates_removed} duplicates.")

    except ImportError:
        print("Error: firebase-admin module not installed. Run 'pip install firebase-admin'")
    except Exception as e:
        print(f"Error processing Firebase: {e}")

if __name__ == "__main__":
    deduplicate_sqlite()
    deduplicate_firebase()
