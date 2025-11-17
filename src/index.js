// /bot/src/index.js
import "dotenv/config";
import { initWhatsapp } from "./whatsapp.js";
import { db, loginBot, cgAgPriv, cgAgPub } from "./firebaseClient.js";
import { onSnapshot, query, where, Timestamp } from "firebase/firestore";
import { parseBooking, maybeSendConfirm } from "./handlers.js";
import { startReminderCron } from "./scheduler.js";

(async () => {
  console.log("[bot] iniciando login Firebase (cliente) ...");
  const user = await loginBot();
  console.log("[bot] logado como:", user.email);

  const wa = await initWhatsapp();

  // ⚠️ ESPERA O READY ANTES DE TUDO
  await new Promise((resolve) => wa.once("ready", resolve));
  console.log("[bot] WA ready – iniciando watchers & scheduler");

  const createdSince = Timestamp.fromDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
  const qPriv = query(cgAgPriv(), where("criadoEm", ">=", createdSince));
  const qPub  = query(cgAgPub(),  where("criadoEm", ">=", createdSince));

  onSnapshot(qPriv, (snap) => {
    snap.docChanges().forEach(async (ch) => {
      const b = parseBooking(ch.doc);
      if (!b.clienteTelefone) return;
      if (ch.type === "added" || ch.type === "modified") {
        try { await maybeSendConfirm({ waClient: wa, booking: b }); }
        catch (e) { console.error("[watch agendamentos] send error:", e); }
      }
    });
  }, (err) => console.error("[watch agendamentos] err:", err));

  onSnapshot(qPub, (snap) => {
    snap.docChanges().forEach(async (ch) => {
      const b = parseBooking(ch.doc);
      if (!b.clienteTelefone) return;
      if (ch.type === "added" || ch.type === "modified") {
        try { await maybeSendConfirm({ waClient: wa, booking: b }); }
        catch (e) { console.error("[watch agendamentos_publicos] send error:", e); }
      }
    });
  }, (err) => console.error("[watch agendamentos_publicos] err:", err));

  // Scheduler só depois do ready também
  startReminderCron(wa);
})();
