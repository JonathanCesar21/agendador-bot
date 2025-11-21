// src/index.js
import "dotenv/config";
import { loginBot, db, cgAgPriv, cgAgPub, botDocRef } from "./firebaseClient.js";
import { startClientFor, stopClientFor, onClientReady, clearAuthFor } from "./whatsapp.js";
import { startReminderCron } from "./scheduler.js";              // só lembretes (T-2h)
import { startReviewWatcher } from "./reviewWatcher.js";         // envia review ao marcar "feito"
import {
  onSnapshot,
  collection,
  query,
  where,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import {
  parseBooking,
  maybeSendConfirm,
  catchUpConfirmationsFor,
} from "./handlers.js";

// Debounce do campo "start" por estabelecimento (evita piscar liga/desliga)
const lastStartFlag = new Map();

/**
 * Watchers de confirmações (confirma ao criar/modificar agendamentos recentes)
 */
async function setupWatchersForRecentConfirmations() {
  const createdSince = Timestamp.fromDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
  const qPriv = query(cgAgPriv(), where("criadoEm", ">=", createdSince));
  const qPub  = query(cgAgPub(),  where("criadoEm", ">=", createdSince));

  onSnapshot(
    qPriv,
    (snap) => {
      snap.docChanges().forEach(async (ch) => {
        const b = parseBooking(ch.doc);
        console.log(
          "[watch agendamentos] change=%s id=%s est=%s tel=%s status=%s",
          ch.type, b.id, b.estabelecimentoId, b.clienteTelefone, b.status
        );
        if (!b.clienteTelefone) return;
        if (ch.type === "added" || ch.type === "modified") {
          try { await maybeSendConfirm({ booking: b }); }
          catch (e) { console.error("[watch agendamentos] send error:", e); }
        }
      });
    },
    (err) => console.error("[watch agendamentos] err:", err)
  );

  onSnapshot(
    qPub,
    (snap) => {
      snap.docChanges().forEach(async (ch) => {
        const b = parseBooking(ch.doc);
        console.log(
          "[watch agendamentos_publicos] change=%s id=%s est=%s tel=%s status=%s",
          ch.type, b.id, b.estabelecimentoId, b.clienteTelefone, b.status
        );
        if (!b.clienteTelefone) return;
        if (ch.type === "added" || ch.type === "modified") {
          try { await maybeSendConfirm({ booking: b }); }
          catch (e) { console.error("[watch agendamentos_publicos] send error:", e); }
        }
      });
    },
    (err) => console.error("[watch agendamentos_publicos] err:", err)
  );
}

(async () => {
  console.log("[bot] login Firebase (cliente) …");
  const user = await loginBot();
  console.log("[bot] logado como:", user.email);

  // Cron apenas para lembretes (ex.: T-2h)
  startReminderCron();

  // Envio de review por watcher (apenas em MODIFIED → status=feito e bot conectado)
  startReviewWatcher();

  // Watchers para confirmações (added/modified nos últimos 3 dias)
  await setupWatchersForRecentConfirmations();

  const singleEst = process.env.ESTABELECIMENTO_ID?.trim();

  if (singleEst) {
    // SINGLE-TENANT
    await startClientFor(singleEst);
    console.log("[bot] single-tenant ativo para:", singleEst);
  } else {
    // MULTI-TENANT: supervisor em /bots
    const col = collection(db, "bots");
    onSnapshot(
      col,
      async (snap) => {
        for (const ch of snap.docChanges()) {
          const estId = ch.doc.id;
          const data  = ch.doc.data() || {};
          const flag  = !!data.start;
          const cmd   = String(data.command || "").toLowerCase();

          // 1) Comando explícito de desconexão → derruba, limpa sessão e reinicia (gera novo QR)
          if (cmd === "disconnect") {
            console.log("[bots supervisor] command=disconnect est=%s", estId);
            try {
              await stopClientFor(estId);
              await clearAuthFor(estId);      // apaga sessão LocalAuth
              await startClientFor(estId);    // religa → QR novo
              await updateDoc(botDocRef(estId), { command: "done" });
            } catch (e) {
              console.error(
                "[bots supervisor] disconnect error est=%s err=%s",
                estId,
                e?.message || e
              );
              try { await updateDoc(botDocRef(estId), { command: "error" }); } catch {}
            }
            continue; // evita cair na lógica de debounce start/stop abaixo nesse ciclo
          }

          // 2) Debounce do campo start
          const prev = lastStartFlag.get(estId);
          if (prev !== flag) {
            lastStartFlag.set(estId, flag);
            console.log("[bots supervisor] change=%s est=%s start=%s", ch.type, estId, flag);
            if (flag) await startClientFor(estId);
            else await stopClientFor(estId);
          }
        }
      },
      (err) => {
        console.error("[bot supervisor] onSnapshot /bots err:", err);
      }
    );

    console.log("[bot] supervisor multi-tenant escutando /bots e watchers CG");
  }

  // Quando QUALQUER cliente ficar ready, faz catch-up apenas de confirmações para esse est.
  onClientReady(async (estId) => {
    try { await catchUpConfirmationsFor(estId); }
    catch (e) { console.error("[catch-up] erro:", e); }
  });
})();
