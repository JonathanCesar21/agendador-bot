// src/index.js
import "dotenv/config";
import { setTimeout as delay } from "timers/promises";

import {
  loginBot,
  db,
  cgAgPriv,
  cgAgPub,
  botDocRef,
} from "./firebaseClient.js";
import {
  startClientFor,
  stopClientFor,
  onClientReady,
  stopAllClients,
  setWatchQr,
} from "./whatsapp.js";
import { startReminderCron } from "./scheduler.js";
import { startReviewWatcher } from "./reviewWatcher.js";

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

/* =====================================================
   LIFELINE — evita queda do processo por exceções
   ===================================================== */
process.on("unhandledRejection", (reason) => {
  console.warn("[process] unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.warn("[process] uncaughtException:", err?.message || err);
});

/* Encerramento limpo ao pausar no console (CTRL+C) */
async function shutdown() {
  console.warn("[process] graceful shutdown…");
  try {
    await stopAllClients();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/* =====================================================
   Debounce / flags por estabelecimento
   ===================================================== */
const lastStartFlag = new Map();
const lastWatchQr = new Map();
const lastCommand = new Map(); // <-- guarda o último command visto pra cada est

/* =====================================================
   Watchers de confirmações (recentes)
   ===================================================== */
async function setupWatchersForRecentConfirmations() {
  const createdSince = Timestamp.fromDate(
    new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  );
  const qPriv = query(cgAgPriv(), where("criadoEm", ">=", createdSince));
  const qPub = query(cgAgPub(), where("criadoEm", ">=", createdSince));

  onSnapshot(
    qPriv,
    (snap) => {
      snap.docChanges().forEach(async (ch) => {
        const b = parseBooking(ch.doc);
        console.log(
          "[watch agendamentos] change=%s id=%s est=%s tel=%s status=%s",
          ch.type,
          b.id,
          b.estabelecimentoId,
          b.clienteTelefone,
          b.status
        );
        if (!b.clienteTelefone) return;
        if (ch.type === "added" || ch.type === "modified") {
          try {
            await maybeSendConfirm({ booking: b });
          } catch (e) {
            console.error("[watch agendamentos] send error:", e);
          }
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
          ch.type,
          b.id,
          b.estabelecimentoId,
          b.clienteTelefone,
          b.status
        );
        if (!b.clienteTelefone) return;
        if (ch.type === "added" || ch.type === "modified") {
          try {
            await maybeSendConfirm({ booking: b });
          } catch (e) {
            console.error(
              "[watch agendamentos_publicos] send error:",
              e
            );
          }
        }
      });
    },
    (err) => console.error("[watch agendamentos_publicos] err:", err)
  );
}

/* =====================================================
   BOOT
   ===================================================== */
(async () => {
  console.log("[bot] iniciando index.js…");
  console.log("[bot] login Firebase (cliente) …");
  const user = await loginBot();
  console.log("[bot] logado como:", user.email);

  // Cron (lembretes T-2h) + watcher de review em "feito" (realtime)
  startReminderCron?.();
  startReviewWatcher?.();

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
    onSnapshot(
      col,
      async (snap) => {
        for (const ch of snap.docChanges()) {
          const estId = ch.doc.id;
          const data = ch.doc.data() || {};
          const flag = !!data.start;
          const cmd = (data.command || "").toLowerCase();

          // Atualiza e guarda último command visto
          const prevCmd = lastCommand.get(estId) || "";
          if (prevCmd !== cmd) {
            console.log(
              "[bots supervisor] est=%s command mudou: %s -> %s",
              estId,
              prevCmd || "(vazio)",
              cmd || "(vazio)"
            );
            lastCommand.set(estId, cmd);
          }

          // Atualiza flag watchQr em memória (evita reads extras no handler de QR)
          const watch = Object.prototype.hasOwnProperty.call(
            data,
            "watchQr"
          )
            ? data.watchQr
            : undefined;
          const prevWatch = lastWatchQr.get(estId);
          if (prevWatch !== watch) {
            lastWatchQr.set(estId, watch);
            setWatchQr(estId, watch);
          }

          // 1) Comando explícito de desconexão → derruba + reinicia (gera novo QR)
          //    Só executa quando HOUVER transição para "disconnect"
          if (cmd === "disconnect" && prevCmd !== "disconnect") {
            console.log(
              "[bots supervisor] command=disconnect est=%s (resetando sessão uma vez)",
              estId
            );

            try {
              try {
                console.log(
                  "[bots supervisor] stopClientFor est=%s…",
                  estId
                );
                await stopClientFor(estId);
              } catch (e) {
                console.error(
                  "[bots supervisor] erro ao parar cliente est=%s err=%s",
                  estId,
                  e?.message || e
                );
              }

              await delay(200); // soltar locks do SO

              try {
                console.log(
                  "[bots supervisor] startClientFor est=%s…",
                  estId
                );
                await startClientFor(estId);
              } catch (e) {
                console.error(
                  "[bots supervisor] erro ao iniciar cliente est=%s err=%s",
                  estId,
                  e?.message || e
                );
              }

              // Tenta marcar como "done" (se falhar, o map lastCommand evita loop)
              try {
                await updateDoc(botDocRef(estId), { command: "done" });
                lastCommand.set(estId, "done");
                console.log(
                  "[bots supervisor] disconnect est=%s finalizado (command=done)",
                  estId
                );
              } catch (e) {
                console.error(
                  "[bots supervisor] erro ao atualizar command=done est=%s err=%s",
                  estId,
                  e?.message || e
                );
              }
            } catch (e) {
              console.error(
                "[bots supervisor] disconnect error est=%s err=%s",
                estId,
                e?.message || e
              );
              try {
                await updateDoc(botDocRef(estId), { command: "error" });
                lastCommand.set(estId, "error");
                console.log(
                  "[bots supervisor] est=%s marcado como command=error",
                  estId
                );
              } catch (err2) {
                console.error(
                  "[bots supervisor] falha ao marcar command=error est=%s err=%s",
                  estId,
                  err2?.message || err2
                );
              }
            }

            // não cai no debounce de start/stop
            continue;
          }

          // 2) Debounce do campo start (liga/desliga robô normalmente)
          const prev = lastStartFlag.get(estId);
          if (prev !== flag) {
            lastStartFlag.set(estId, flag);
            console.log(
              "[bots supervisor] change=%s est=%s start=%s",
              ch.type,
              estId,
              flag
            );
            if (flag) await startClientFor(estId);
            else await stopClientFor(estId);
          }
        }
      },
      (err) => {
        console.error("[bot supervisor] onSnapshot /bots err:", err);
      }
    );

    console.log(
      "[bot] supervisor multi-tenant escutando /bots e watchers CG"
    );
  }

  // Quando QUALQUER cliente ficar ready, roda catch-up para ele
  onClientReady(async (estId) => {
    try {
      await catchUpConfirmationsFor(estId);
    } catch (e) {
      console.error("[catch-up] erro:", e);
    }
  });
})();
