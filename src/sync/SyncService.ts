import { collection, getDocs, doc, writeBatch, query, where, orderBy, limit } from "firebase/firestore";
import { db, auth } from "../firebase";
import { ScheduleItem } from "../types/schedule";
import { ScheduleService } from "../services/ScheduleService";

const COLLECTION_EVENTS = "events";

// 날짜 문자열을 iOS 가 파싱할 수 있는 형식(JS toISOString: 밀리초 + 'Z')으로 통일한다.
// Rust 백엔드(브리핑 AI 등)는 chrono `to_rfc3339()` 로 `2026-07-02T01:08:34.222295300+00:00`
// 같은 나노초 + '+00:00' 형식을 쓰는데, Swift 의 엄격한 ISO8601/Codable 디코더는 이걸
// 파싱하지 못해 이벤트 문서를 통째로 버린다(웹은 느슨한 JS Date 라 보임 → iOS 에서만 누락).
function toIsoZ(s: string | null | undefined): string {
    if (!s) return s as string;
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toISOString();
}

// Firestore 로 내보낼 때만 적용하는 정규화.
//  1) 타입: 외부 리더는 manual_todo / period_schedule / message_task 만 인식한다.
//     탁상달력에서 가져온 desktopcal_memo · desktopcal_event 를 리더가 아는 타입으로 매핑.
//     (로컬 DB 타입은 그대로 둔다 — 탁상달력 역동기화가 그 타입으로 중복을 거른다.)
//  2) 감사 날짜(createdAt/updatedAt): iOS 파싱 가능한 형식으로 통일.
function normalizeForRemote(item: ScheduleItem): ScheduleItem {
    let type = item.type;
    if (type === 'desktopcal_memo') type = 'manual_todo';
    else if (type === 'desktopcal_event') type = 'period_schedule';
    return {
        ...item,
        type,
        createdAt: toIsoZ(item.createdAt),
        updatedAt: toIsoZ(item.updatedAt),
    };
}

export const SyncService = {
    async syncData(lastSyncTime: string | null): Promise<string> {
        const user = auth.currentUser;
        if (!user) {
            throw new Error("User not authenticated");
        }

        const newSyncTime = new Date().toISOString();
        let batch = writeBatch(db);
        let batchCount = 0;

        // 1. Get Local Data
        // We fetch ALL schedules for now to ensure we have everything for merging.
        // Optimization: Fetch only modified if we trust the modification time, 
        // but for safety in this transition, let's fetch all.
        // Or better: Fetch all from local DB.
        const start = new Date('2000-01-01');
        const end = new Date('2100-12-31');
        const localItems = await ScheduleService.getSchedules({ start, end }, true);

        // 2. Get Remote Data
        const eventsRef = collection(db, "users", user.uid, COLLECTION_EVENTS);

        // ── 일회성 전체 재푸시 마이그레이션 ────────────────────────────────
        // 두 부류의 이벤트가 iOS 에서 누락돼 왔다:
        //  (a) 탁상달력 유래 desktopcal_* 타입 (리더가 모르는 타입이라 버려짐)
        //  (b) Rust(브리핑 AI 등)가 만든 이벤트 (createdAt/updatedAt 이 나노초
        //      +00:00 형식 → iOS 디코더가 문서째 버림). 게다가 이들 updatedAt 은
        //      대개 lastSyncTime 보다 과거라 증분 동기화로는 영영 다시 안 올라간다.
        // → 전체 로컬 이벤트를 리더 친화 형식(normalizeForRemote)으로 한 번 다시
        //   밀어넣어 기존 원격 문서를 덮어쓴다. 이후 신규/변경분은 일반 푸시 경로가
        //   같은 정규화를 적용한다. (이미 올바른 문서도 동일 데이터로 덮어써 무해.)
        {
            const { invoke } = await import('@tauri-apps/api/core');
            const RESYNC_KEY = 'EventDateFormatResyncV1Done';
            const done = await invoke<string | null>('get_registry_value', { key: RESYNC_KEY });
            if (done !== 'true') {
                let migBatch = writeBatch(db);
                let pending = 0;
                let migrated = 0;
                for (const item of localItems) {
                    migBatch.set(doc(eventsRef, item.id), normalizeForRemote(item));
                    pending++;
                    migrated++;
                    if (pending >= 450) {
                        await migBatch.commit();
                        migBatch = writeBatch(db);
                        pending = 0;
                    }
                }
                if (pending > 0) await migBatch.commit();
                await invoke('set_registry_value', { key: RESYNC_KEY, value: 'true' });
                console.log(`Event resync: re-pushed ${migrated} events for external readers`);
            }
        }

        let remoteItems: ScheduleItem[] = [];

        try {
            // Fetch all remote items for now to ensure full sync
            // Optimization: Use updated_at query if lastSyncTime exists
            let q = query(eventsRef);
            if (lastSyncTime) {
                q = query(eventsRef, where("updatedAt", ">", lastSyncTime));
            }
            const snapshot = await getDocs(q);
            remoteItems = snapshot.docs.map(d => d.data() as ScheduleItem);

            // If we only fetched modified, we need to know about others?
            // No, for Last Write Wins, we only care about what changed.
            // But if we want to update local with remote changes, we need those remote changes.
            // If we want to update remote with local changes, we need to know if remote is older.

            // If lastSyncTime is set, we might miss items that were created on another device 
            // but not yet synced here.
            // So fetching "modified since lastSyncTime" from remote is correct for "pulling updates".

            // But for "pushing updates", we need to compare with remote state.
            // If we blindly push local > lastSyncTime, we might overwrite newer remote changes 
            // if clocks are off or race conditions.
            // But standard sync usually relies on timestamps.

            // Let's stick to:
            // 1. Pull remote changes (modified > lastSync) -> Update Local
            // 2. Push local changes (modified > lastSync) -> Update Remote

            // However, we need to handle conflicts.
            // If both changed, usually LWW (Last Write Wins) based on updatedAt.

            // To do LWW properly, we need the CURRENT remote state for the items we want to push.
            // But fetching everything is expensive.

            // Simplified approach for now:
            // 1. Pull all remote items modified > lastSyncTime.
            // 2. For each remote item:
            //    - Find local item.
            //    - If local is older (or missing), update local.
            //    - If local is newer, do nothing (we will push it in step 3).
            // 3. Find all local items modified > lastSyncTime.
            // 4. For each local item:
            //    - If it was updated from remote in step 2, skip.
            //    - Else, push to remote (blindly? or check remote timestamp?).
            //      - Firestore rules can enforce timestamp check, or we can just overwrite.
            //      - Let's overwrite for now (Client Wins / LWW).

        } catch (e) {
            console.error("Error fetching remote data:", e);
            throw e;
        }

        // 3. Process Remote Changes (Update Local)
        console.log(`DEBUG: Processing ${remoteItems.length} remote items`);
        const localMap = new Map(localItems.map(i => [i.id, i]));
        const remoteMap = new Map(remoteItems.map(i => [i.id, i]));

        for (const remote of remoteItems) {
            const local = localMap.get(remote.id);

            if (!local) {
                // New from remote
                console.log(`DEBUG: Creating new local schedule from remote: ${remote.id} (${remote.title})`);
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('create_schedule', { item: remote });
            } else {
                // Conflict resolution
                const remoteTime = new Date(remote.updatedAt).getTime();
                const localTime = new Date(local.updatedAt).getTime();

                if (remoteTime > localTime) {
                    // Remote is newer, update local
                    console.log(`DEBUG: Updating local schedule from remote: ${remote.id}`);
                    await ScheduleService.updateScheduleItem(remote);
                }
            }
        }

        // 4. Process Local Changes (Push to Remote)
        const localItemsToPush = localItems.filter(local => {
            if (!lastSyncTime) return true;
            return new Date(local.updatedAt) > new Date(lastSyncTime);
        });

        for (const local of localItemsToPush) {
            // Check if we just updated this from remote
            const remote = remoteMap.get(local.id);
            if (remote) {
                const remoteTime = new Date(remote.updatedAt).getTime();
                const localTime = new Date(local.updatedAt).getTime();
                if (remoteTime >= localTime) {
                    // Remote was newer or equal, so we already updated local (or they are in sync).
                    // Don't push back.
                    continue;
                }
            }

            // Push to remote (외부 리더용으로 타입·날짜 정규화해서 저장)
            const docRef = doc(eventsRef, local.id);
            batch.set(docRef, normalizeForRemote(local));
            batchCount++;

            if (batchCount >= 450) {
                await batch.commit();
                batch = writeBatch(db);
                batchCount = 0;
            }
        }

        if (batchCount > 0) {
            await batch.commit();
            console.log(`Pushed ${batchCount} changes to Firestore`);
        }

        return newSyncTime;
    },

    async syncMessages(udbPath: string, onProgress?: (current: number, total: number) => void) {
        const user = auth.currentUser;
        if (!user) throw new Error("User not authenticated");

        const { invoke } = await import('@tauri-apps/api/core');

        console.log("Starting message sync...");

        // 1. Get last synced message ID from Firestore
        const messagesRef = collection(db, "users", user.uid, "messages");
        const lastMsgQuery = query(messagesRef, where("id", ">", 0), orderBy("id", "desc"), limit(1));
        const lastMsgSnap = await getDocs(lastMsgQuery);

        let lastId: number | null = null;
        if (!lastMsgSnap.empty) {
            lastId = lastMsgSnap.docs[0].data().id;
            console.log(`Last synced message ID: ${lastId}`);
        } else {
            console.log("No previous messages found. Syncing all.");
        }

        // 2. Get total count of NEW messages
        interface PaginatedMessages {
            messages: any[];
            total_count: number;
        }

        const initialResult = await invoke<PaginatedMessages>('read_udb_messages', {
            dbPath: udbPath,
            limit: 1,
            offset: 0,
            searchTerm: null,
            minId: lastId // Pass min_id to Rust
        });

        const totalNew = initialResult.total_count;
        console.log(`Total new messages to sync: ${totalNew}`);

        if (totalNew === 0) {
            if (onProgress) onProgress(0, 0); // Indicate completion/nothing to do
            return;
        }

        const CHUNK_SIZE = 50; // Reduced to 50 to prevent resource exhaustion
        let processed = 0;

        // 3. Fetch and upload in chunks
        while (processed < totalNew) {
            // Fetch chunk from Rust
            const chunkResult = await invoke<PaginatedMessages>('read_udb_messages', {
                dbPath: udbPath,
                limit: CHUNK_SIZE,
                offset: processed,
                searchTerm: null,
                minId: lastId
            });

            const messages = chunkResult.messages;
            if (messages.length === 0) break;

            // Retry logic for batch commit
            let retries = 3;
            while (retries > 0) {
                try {
                    const batch = writeBatch(db);
                    for (const msg of messages) {
                        const docRef = doc(messagesRef, msg.id.toString());
                        // Truncate size to avoid Firebase 1MB limit for document
                        if (msg.content && msg.content.length > 800000) {
                            msg.content = msg.content.substring(0, 800000) + "\n... [내용이 너무 길어 동기화 과정에서 생략되었습니다]";
                        }
                        batch.set(docRef, msg);
                    }
                    await batch.commit();
                    break; // Success
                } catch (e: any) {
                    console.error(`Batch commit failed. Retries left: ${retries - 1}`, e);
                    if (retries === 1) throw e; // Throw on last retry
                    retries--;
                    // Exponential backoff: 2s, 4s, 8s
                    await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries)));
                }
            }

            processed += messages.length;

            if (onProgress) {
                onProgress(processed, totalNew);
            }

            // Delay to prevent "Write stream exhausted" and UI freezing
            // Increased to 2000ms to be safer
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log("Message sync complete.");
    }
};
