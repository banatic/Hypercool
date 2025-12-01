import { collection, getDocs, doc, writeBatch, query, where } from "firebase/firestore";
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
            // If fetch fails, we can still push local changes? 
            // Or maybe abort? For now, let's abort to avoid overwriting remote with stale data if we couldn't check it.
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
            // 2. It's newer than lastSyncTime (meaning it was modified locally recently)
            // 3. It's newer than the remote version we just fetched (conflict resolution won by local)
            //    OR remote doesn't exist (new item)

            const isLocalContent = local && todo.updatedAt === local.updatedAt;
            const isRecentlyModified = !lastSyncTime || new Date(todo.updatedAt) > new Date(lastSyncTime);
            const isNewerThanRemote = !remote || new Date(todo.updatedAt) > new Date(remote.updatedAt);

            if (isLocalContent && isRecentlyModified && isNewerThanRemote) {
                const docRef = doc(todosRef, todo.id);
                batch.set(docRef, todo);
                batchCount++;
            }
        }

        for (const schedule of mergedSchedulesMap.values()) {
            const local = localSchedules.find(s => s.id === schedule.id);
            const remote = remoteSchedules.find(s => s.id === schedule.id);

            const isLocalContent = local && schedule.updatedAt === local.updatedAt;
            const isRecentlyModified = !lastSyncTime || new Date(schedule.updatedAt) > new Date(lastSyncTime);
            const isNewerThanRemote = !remote || new Date(schedule.updatedAt) > new Date(remote.updatedAt);

            if (isLocalContent && isRecentlyModified && isNewerThanRemote) {
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
    }
};
