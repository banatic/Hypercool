import { collection, getDocs, doc, writeBatch, query, where, orderBy, limit } from "firebase/firestore";
import { db, auth } from "../firebase";
import { ManualTodo, PeriodSchedule } from "../types";

const COLLECTION_TODOS = "todos";
const COLLECTION_SCHEDULES = "schedules";

export const SyncService = {
    async syncData(
        localTodos: ManualTodo[],
        localSchedules: PeriodSchedule[],
        lastSyncTime: string | null
    ): Promise<{
        mergedTodos: ManualTodo[];
        mergedSchedules: PeriodSchedule[];
        newSyncTime: string;
    }> {
        const user = auth.currentUser;
        if (!user) {
            throw new Error("User not authenticated");
        }

        const newSyncTime = new Date().toISOString();
        const batch = writeBatch(db);
        let batchCount = 0;

        // 1. Pull changes from Firestore
        const todosRef = collection(db, "users", user.uid, COLLECTION_TODOS);
        const schedulesRef = collection(db, "users", user.uid, COLLECTION_SCHEDULES);

        let remoteTodos: ManualTodo[] = [];
        let remoteSchedules: PeriodSchedule[] = [];

        try {
            if (lastSyncTime) {
                const qTodos = query(todosRef, where("updatedAt", ">", lastSyncTime));
                const qSchedules = query(schedulesRef, where("updatedAt", ">", lastSyncTime));

                const [todosSnap, schedulesSnap] = await Promise.all([
                    getDocs(qTodos),
                    getDocs(qSchedules)
                ]);

                remoteTodos = todosSnap.docs.map(d => d.data() as ManualTodo);
                remoteSchedules = schedulesSnap.docs.map(d => d.data() as PeriodSchedule);
            } else {
                // First sync: get all
                const [todosSnap, schedulesSnap] = await Promise.all([
                    getDocs(todosRef),
                    getDocs(schedulesRef)
                ]);
                remoteTodos = todosSnap.docs.map(d => d.data() as ManualTodo);
                remoteSchedules = schedulesSnap.docs.map(d => d.data() as PeriodSchedule);
            }
        } catch (e) {
            console.error("Error fetching remote data:", e);
            throw e;
        }

        // 2. Merge Logic (Last Write Wins)
        const mergedTodosMap = new Map<string, ManualTodo>();
        localTodos.forEach(t => mergedTodosMap.set(t.id, t));

        remoteTodos.forEach(remote => {
            const local = mergedTodosMap.get(remote.id);
            if (!local || new Date(remote.updatedAt) > new Date(local.updatedAt)) {
                mergedTodosMap.set(remote.id, remote);
            }
        });

        const mergedSchedulesMap = new Map<string, PeriodSchedule>();
        localSchedules.forEach(s => mergedSchedulesMap.set(s.id, s));

        remoteSchedules.forEach(remote => {
            const local = mergedSchedulesMap.get(remote.id);
            if (!local || new Date(remote.updatedAt) > new Date(local.updatedAt)) {
                mergedSchedulesMap.set(remote.id, remote);
            }
        });

        // 3. Push changes to Firestore
        for (const todo of mergedTodosMap.values()) {
            const local = localTodos.find(t => t.id === todo.id);
            const remote = remoteTodos.find(t => t.id === todo.id);

            // We push if:
            // 1. It's a local item (or merged result is same as local)
            // 2. AND (It's recently modified OR It's missing from remote OR It's newer than remote)

            const isLocalContent = local && todo.updatedAt === local.updatedAt;
            const isMissingRemote = !remote;
            const isRecentlyModified = !lastSyncTime || new Date(todo.updatedAt) > new Date(lastSyncTime);
            const isNewerThanRemote = remote && new Date(todo.updatedAt) > new Date(remote.updatedAt);

            if (isLocalContent && (isRecentlyModified || isMissingRemote || isNewerThanRemote)) {
                const docRef = doc(todosRef, todo.id);
                batch.set(docRef, todo);
                batchCount++;
            }
        }

        for (const schedule of mergedSchedulesMap.values()) {
            const local = localSchedules.find(s => s.id === schedule.id);
            const remote = remoteSchedules.find(s => s.id === schedule.id);

            const isLocalContent = local && schedule.updatedAt === local.updatedAt;
            const isMissingRemote = !remote;
            const isRecentlyModified = !lastSyncTime || new Date(schedule.updatedAt) > new Date(lastSyncTime);
            const isNewerThanRemote = remote && new Date(schedule.updatedAt) > new Date(remote.updatedAt);

            if (isLocalContent && (isRecentlyModified || isMissingRemote || isNewerThanRemote)) {
                const docRef = doc(schedulesRef, schedule.id);
                batch.set(docRef, schedule);
                batchCount++;
            }
        }

        if (batchCount > 0) {
            await batch.commit();
            console.log(`Pushed ${batchCount} changes to Firestore`);
        }

        return {
            mergedTodos: Array.from(mergedTodosMap.values()),
            mergedSchedules: Array.from(mergedSchedulesMap.values()),
            newSyncTime
        };
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
    },

    async syncMessageMetadata(
        deadlines: Record<string, string | null>,
        calendarTitles: Record<string, string>
    ) {
        const user = auth.currentUser;
        if (!user) return;

        console.log("Syncing message metadata (deadlines/titles)...");
        const messagesRef = collection(db, "users", user.uid, "messages");
        const batch = writeBatch(db);
        let batchCount = 0;

        // Sync all deadlines/titles
        // Since we don't track modification time for these, we sync all non-null ones.
        // Optimization: In a real app, we should track 'metadataUpdatedAt'.
        // For now, assuming the number of scheduled messages is reasonable (< 500 per sync).

        const uniqueIds = new Set([...Object.keys(deadlines), ...Object.keys(calendarTitles)]);

        for (const id of uniqueIds) {
            const deadline = deadlines[id];
            const calendarTitle = calendarTitles[id];

            // Only update if there is something to update
            if (deadline || calendarTitle) {
                const docRef = doc(messagesRef, id);
                // Use set with merge: true to update fields without overwriting the whole doc
                // or creating it if it doesn't exist (though it should exist if we are scheduling it)
                // Note: If message doesn't exist on server yet (not synced), this will create a partial doc.
                // When the actual message syncs, it should merge or overwrite?
                // SyncService.syncMessages uses batch.set() which overwrites.
                // So we should run syncMessages FIRST, then syncMessageMetadata.

                batch.set(docRef, {
                    deadline: deadline || null,
                    calendarTitle: calendarTitle || null
                }, { merge: true });

                batchCount++;

                if (batchCount >= 450) { // Firestore batch limit is 500
                    await batch.commit();
                    batchCount = 0;
                }
            }
        }

        if (batchCount > 0) {
            await batch.commit();
            console.log(`Synced metadata for ${batchCount} messages.`);
        }
    }
};
