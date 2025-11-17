// /bot/src/scheduler.js
import cron from "node-cron";
import {
  db,
} from "./firebaseClient.js";
import {
  query, where, orderBy, getDocs, Timestamp, collectionGroup
} from "firebase/firestore";
import { parseBooking, sendReminder } from "./handlers.js";

export function startReminderCron(waClient) {
  const warmup = Number(process.env.REMINDER_WARMUP_MINUTES || 5);

  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const end   = new Date(start.getTime() + warmup * 60 * 1000);

    try {
      const qPriv = query(
        collectionGroup(db, "agendamentos"),
        where("inicio", ">=", Timestamp.fromDate(start)),
        where("inicio", "<=", Timestamp.fromDate(end)),
        orderBy("inicio", "asc")
      );
      const qPub = query(
        collectionGroup(db, "agendamentos_publicos"),
        where("inicio", ">=", Timestamp.fromDate(start)),
        where("inicio", "<=", Timestamp.fromDate(end)),
        orderBy("inicio", "asc")
      );

      for (const q of [qPriv, qPub]) {
        const snap = await getDocs(q);
        for (const d of snap.docs) {
          const b = parseBooking(d);
          if (b.status === "cancelado") continue;
          if (b.lembreteEnviado) continue;
          if (!b.clienteTelefone) continue;
          await sendReminder({ waClient, booking: { ...b, clienteTelefone: b.clienteTelefone } });
        }
      }
    } catch (e) {
      console.error("[scheduler] reminder error:", e);
    }
  });

  console.log("[scheduler] lembretes T-2h iniciados (*/1m)");
}
