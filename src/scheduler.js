// src/scheduler.js
import cron from "node-cron";
import { db } from "./firebaseClient.js";
import {
  query,
  where,
  orderBy,
  getDocs,
  Timestamp,
  collectionGroup,
} from "firebase/firestore";
import { parseBooking, sendReminder, sendReviewRequest } from "./handlers.js";

/**
 * LEMBRETES T-2h
 * - Roda a cada 1 minuto
 * - Procura agendamentos com início entre [agora+2h, agora+2h+warmup]
 * - Envia lembrete se ainda não enviado
 */
export function startReminderCron() {
  const warmup = Number(process.env.REMINDER_WARMUP_MINUTES || 5);

  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + warmup * 60 * 1000);

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
          await sendReminder({ booking: b });
        }
      }
    } catch (e) {
      console.error("[scheduler] reminder error:", e);
    }
  });

  console.log("[scheduler] lembretes T-2h iniciados (*/1m)");
}

/**
 * PEDIDOS DE AVALIAÇÃO +1h
 * - Roda a cada 1 minuto
 * - Procura agendamentos cujo início foi há ~1h (configurável)
 * - Envia pedido de avaliação se:
 *   - estabelecimento tem googleReviewLink
 *   - ainda não foi enviado (reviewSent == false)
 */
export function startReviewCron() {
  const reviewDelayMin = Number(process.env.REVIEW_DELAY_MINUTES || 60); // padrão: 60min
  const reviewWindowMin = Number(process.env.REVIEW_WINDOW_MINUTES || 5); // janela de 5min

  cron.schedule("* * * * *", async () => {
    const now = new Date();

    // buscar agendamentos cujo inicio caiu entre [agora - delay - janela, agora - delay]
    const end = new Date(now.getTime() - reviewDelayMin * 60 * 1000);
    const start = new Date(end.getTime() - reviewWindowMin * 60 * 1000);

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
          if (!b.clienteTelefone) continue;
          if (b.reviewSent) continue;
          // se quiser filtrar por status (ex.: somente "atendido"), você pode adicionar aqui.
          await sendReviewRequest({ booking: b });
        }
      }
    } catch (e) {
      console.error("[scheduler] review error:", e);
    }
  });

  console.log("[scheduler] pedidos de avaliação +1h iniciados (*/1m)");
}
