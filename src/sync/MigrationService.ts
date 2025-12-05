import { collection, getDocs, doc, writeBatch } from "firebase/firestore";
import { db, auth } from "../firebase";
import { ScheduleItem } from "../types/schedule";

const COLLECTION_TODOS = "todos";
const COLLECTION_SCHEDULES = "schedules";
const COLLECTION_EVENTS = "events";

export const MigrationService = {
    async migrateFirestoreData() {
        const user = auth.currentUser;
        if (!user) throw new Error("User not authenticated");

        console.log("Starting Firestore migration to events collection...");
        const batch = writeBatch(db);
        let batchCount = 0;

        // 1. Migrate Todos
        const todosRef = collection(db, "users", user.uid, COLLECTION_TODOS);
        const todosSnap = await getDocs(todosRef);

        for (const docSnap of todosSnap.docs) {
            const todo = docSnap.data();
            const scheduleItem: any = {
                id: todo.id,
                type: 'manual_todo',
                title: todo.calendarTitle || todo.content || "할 일",
                content: todo.content || "",
                startDate: todo.deadline || "", // Ensure string if interface requires it, or null if allowed. Let's use "" for now if missing to match type, or null if we change type.
                // Actually, let's use null and cast to any because Firestore supports null and it's better semantics for "no date".
                // But wait, if I use null, the frontend might crash if it expects string.
                // The frontend ScheduleItem interface says string.
                // Let's check if the frontend handles empty string or null.
                // For now, let's use null for optional fields like referenceId/color, and ensure others are safe.
                // But for startDate/endDate, if they are missing in todo, what should they be?
                // ManualTodo has deadline.
                endDate: todo.deadline || "",
                isAllDay: false,
                referenceId: null, // Explicitly null for Firestore
                color: null,       // Explicitly null for Firestore
                isCompleted: false,
                createdAt: todo.createdAt || new Date().toISOString(),
                updatedAt: todo.updatedAt || new Date().toISOString(),
                isDeleted: todo.isDeleted || false
            };

            const eventRef = doc(db, "users", user.uid, COLLECTION_EVENTS, scheduleItem.id);
            batch.set(eventRef, scheduleItem);
            batchCount++;
        }

        // 2. Migrate Schedules
        const schedulesRef = collection(db, "users", user.uid, COLLECTION_SCHEDULES);
        const schedulesSnap = await getDocs(schedulesRef);

        for (const docSnap of schedulesSnap.docs) {
            const schedule = docSnap.data();
            const scheduleItem: any = {
                id: schedule.id,
                type: 'period_schedule',
                title: schedule.calendarTitle || schedule.content || "일정",
                content: schedule.content || "",
                startDate: schedule.startDate || "",
                endDate: schedule.endDate || "",
                isAllDay: false,
                referenceId: null,
                color: null,
                isCompleted: false,
                createdAt: schedule.createdAt || new Date().toISOString(),
                updatedAt: schedule.updatedAt || new Date().toISOString(),
                isDeleted: schedule.isDeleted || false
            };

            const eventRef = doc(db, "users", user.uid, COLLECTION_EVENTS, scheduleItem.id);
            batch.set(eventRef, scheduleItem);
            batchCount++;
        }

        if (batchCount > 0) {
            await batch.commit();
            console.log(`Migrated ${batchCount} items to events collection.`);
        } else {
            console.log("No items to migrate.");
        }
    }
};
