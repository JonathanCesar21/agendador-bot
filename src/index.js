// /bot/src/index.js
import "dotenv/config";
import { loginBot, db, cgAgPriv, cgAgPub } from "./firebaseClient.js";
import { startClientFor, stopClientFor, onClientReady } from "./whatsapp.js";
import { startReminderCron } from "./scheduler.js";
import {
  onSnapshot,
  collection,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { parseBooking, maybeSendConfirm, catchUpConfirmationsFor } from "./handlers.js";

// Debounce do campo "start" por estabelecimento (evita piscar liga/desliga)
const lastStartFlag = new Map();

async function setupWatchersForRecentConfirmations() {
  const createdSince = Timestamp.fromDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
  const qPriv = query(cgAgPriv(), where("criadoEm", ">=", createdSince));
  const qPub  = query(cgAgPub(),  where("criadoEm", ">=", createdSince));

  onSnapshot(qPriv, (snap) => {
    snap.docChanges().forEach(async (ch) => {
      const b = parseBooking(ch.doc);
      console.log("[watch agendamentos] change=%s id=%s est=%s tel=%s status=%s",
        ch.type, b.id, b.estabelecimentoId, b.clienteTelefone, b.status);
      if (!b.clienteTelefone) return;
      if (ch.type === "added" || ch.type === "modified") {
        try { await maybeSendConfirm({ booking: b }); }
        catch (e) { console.error("[watch agendamentos] send error:", e); }
      }
    });
  }, (err) => console.error("[watch agendamentos] err:", err));

  onSnapshot(qPub, (snap) => {
    snap.docChanges().forEach(async (ch) => {
      const b = parseBooking(ch.doc);
      console.log("[watch agendamentos_publicos] change=%s id=%s est=%s tel=%s status=%s",
        ch.type, b.id, b.estabelecimentoId, b.clienteTelefone, b.status);
      if (!b.clienteTelefone) return;
      if (ch.type === "added" || ch.type === "modified") {
        try { await maybeSendConfirm({ booking: b }); }
        catch (e) { console.error("[watch agendamentos_publicos] send error:", e); }
      }
    });
  }, (err) => console.error("[watch agendamentos_publicos] err:", err));
}

(async () => {
  console.log("[bot] login Firebase (cliente) …");
  const user = await loginBot();
  console.log("[bot] logado como:", user.email);

  // Cron (lembretes T-2h)
  startReminderCron();

  // Watchers para confirmações
  await setupWatchersForRecentConfirmations();

  const singleEst = process.env.ESTABELECIMENTO_ID?.trim();

  if (singleEst) {
    // SINGLE-TENANT
    await startClientFor(singleEst);
    console.log("[bot] single-tenant ativo para:", singleEst);
  } else {
    // MULTI-TENANT: supervisor em /bots
    const col = collection(db, "bots");
    onSnapshot(col, async (snap) => {
      for (const ch of snap.docChanges()) {
        const estId = ch.doc.id;
        const data = ch.doc.data() || {};
        const flag = !!data.start;

        const prev = lastStartFlag.get(estId);
        if (prev === flag) continue; // ignora ruído
        lastStartFlag.set(estId, flag);

        console.log("[bots supervisor] change=%s est=%s start=%s", ch.type, estId, flag);
        if (flag) await startClientFor(estId);
        else await stopClientFor(estId);
      }
    }, (err) => {
      console.error("[bot supervisor] onSnapshot /bots err:", err);
    });

    console.log("[bot] supervisor multi-tenant escutando /bots e watchers CG");
  }

  // Quando QUALQUER cliente ficar ready, roda catch-up para ele
  onClientReady(async (estId) => {
    try { await catchUpConfirmationsFor(estId); }
    catch (e) { console.error("[catch-up] erro:", e); }
  });
})();
