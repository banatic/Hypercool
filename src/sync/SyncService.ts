import { collection, getDocs, doc, writeBatch, query, where, orderBy, limit } from "firebase/firestore";
import { db, auth } from "../firebase";
import { ScheduleItem } from "../types/schedule";
import { ScheduleService } from "../services/ScheduleService";

const COLLECTION_EVENTS = "events";

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
        const localItems = await ScheduleService.getSchedules({ start, end });

        // 2. Get Remote Data
        const eventsRef = collection(db, "users", user.uid, COLLECTION_EVENTS);
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
        for (const remote of remoteItems) {
            const local = localItems.find(i => i.id === remote.id);

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
        // We need to re-fetch local items if we updated them? 
        // Or just track what we updated.
        // Actually, we only push items that were NOT updated from remote just now.

        const localItemsToPush = localItems.filter(local => {
            // If we just updated it from remote, local.updatedAt matches remote.updatedAt (roughly).
            // But we updated it in DB, so `localItems` array is stale for those.
            // But we want to push items that are NEWER than lastSyncTime AND NOT updated from remote.

            // If lastSyncTime is null, push everything (except what we just pulled).
            if (!lastSyncTime) return true;

            return new Date(local.updatedAt) > new Date(lastSyncTime);
        });

        for (const local of localItemsToPush) {
            // Check if we just updated this from remote
            const remote = remoteItems.find(r => r.id === local.id);
            if (remote) {
                const remoteTime = new Date(remote.updatedAt).getTime();
                const localTime = new Date(local.updatedAt).getTime();
                if (remoteTime >= localTime) {
                    // Remote was newer or equal, so we already updated local (or they are in sync).
                    // Don't push back.
                    continue;
                }
            }

            // Push to remote
            const docRef = doc(eventsRef, local.id);
            batch.set(docRef, local);
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

            // Upload chunk to Firestore
            const batch = writeBatch(db);
            for (const msg of messages) {
                const docRef = doc(messagesRef, msg.id.toString());
                batch.set(docRef, msg);
            }

            // Retry logic for batch commit
            let retries = 3;
            while (retries > 0) {
                try {
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
