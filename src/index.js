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
   Maps de controle
   ===================================================== */
const lastWatchQr = new Map();   // estId -> boolean|undefined
const lastCommand = new Map();   // estId -> string
const lastRunDecision = new Map(); // estId -> boolean

const stopTimers = new Map();
const QR_IDLE_STOP_MS = Number(process.env.QR_IDLE_STOP_MS || 20000); // 20s

function cancelStop(estId) {
  const t = stopTimers.get(estId);
  if (t) {
    try { clearTimeout(t); } catch {}
    stopTimers.delete(estId);
  }
}

function scheduleStop(estId) {
  cancelStop(estId);
  const t = setTimeout(async () => {
    if (lastRunDecision.get(estId) === false) {
      try {
        console.log("[bots supervisor] idle-stop est=%s", estId);
        await stopClientFor(estId);
      } catch {}
    }
  }, QR_IDLE_STOP_MS);
  stopTimers.set(estId, t);
}

// TTL opcional para evitar watchQr “preso” em true se o navegador cair
const WATCHQR_TTL_MS = Number(process.env.WATCHQR_TTL_MS || 90000); // 90s
function isWatchQrActive(data) {
  const watch = data?.watchQr === true;
  if (!watch) return false;

  // se não tiver watchQrAt, assume ativo (compatibilidade)
  const t = data?.watchQrAt?.toDate ? data.watchQrAt.toDate().getTime() : 0;
  if (!t) return true;

  return Date.now() - t <= WATCHQR_TTL_MS;
}

/* =====================================================
   Watchers de confirmações (recentes)
   ===================================================== */
async function setupWatchersForRecentConfirmations() {
  const createdSince = Timestamp.fromDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
  const qPriv = query(cgAgPriv(), where("criadoEm", ">=", createdSince));
  const qPub = query(cgAgPub(), where("criadoEm", ">=", createdSince));

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

/* =====================================================
   BOOT
   ===================================================== */
(async () => {
  console.log("[bot] iniciando index.js…");
  console.log("[bot] login Firebase (cliente) …");
  const user = await loginBot();
  console.log("[bot] logado como:", user.email);

  startReminderCron?.();
  startReviewWatcher?.();

  await setupWatchersForRecentConfirmations();

  const singleEst = process.env.ESTABELECIMENTO_ID?.trim();

  if (singleEst) {
    await startClientFor(singleEst);
    console.log("[bot] single-tenant ativo para:", singleEst);
  } else {
    const col = collection(db, "bots");

    onSnapshot(
      col,
      async (snap) => {
        for (const ch of snap.docChanges()) {
          const estId = ch.doc.id;
          const data = ch.doc.data() || {};

          const flagStart = !!data.start;
          const cmd = (data.command || "").toLowerCase();

          // 0) command anterior
          const prevCmd = lastCommand.get(estId) || "";
          if (prevCmd !== cmd) {
            console.log(
              "[bots supervisor] est=%s command mudou: %s -> %s",
              estId, prevCmd || "(vazio)", cmd || "(vazio)"
            );
            lastCommand.set(estId, cmd);
          }

          // 1) watchQr em memória (para o whatsapp.js decidir gravar QR)
          const watch = Object.prototype.hasOwnProperty.call(data, "watchQr")
            ? data.watchQr
            : undefined;

          const prevWatch = lastWatchQr.get(estId);
          if (prevWatch !== watch) {
            lastWatchQr.set(estId, watch);
            setWatchQr(estId, watch);
          }

          // 2) comando disconnect (mantém sua lógica)
          if (cmd === "disconnect" && prevCmd !== "disconnect") {
            console.log(
              "[bots supervisor] command=disconnect est=%s (resetando sessão uma vez)",
              estId
            );

            cancelStop(estId);
            lastRunDecision.set(estId, true);

            try {
              try {
                console.log("[bots supervisor] stopClientFor est=%s…", estId);
                await stopClientFor(estId);
              } catch (e) {
                console.error(
                  "[bots supervisor] erro ao parar cliente est=%s err=%s",
                  estId, e?.message || e
                );
              }

              await delay(200);

              try {
                console.log("[bots supervisor] startClientFor est=%s…", estId);
                await startClientFor(estId);
              } catch (e) {
                console.error(
                  "[bots supervisor] erro ao iniciar cliente est=%s err=%s",
                  estId, e?.message || e
                );
              }

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
                  estId, e?.message || e
                );
              }
            } catch (e) {
              console.error(
                "[bots supervisor] disconnect error est=%s err=%s",
                estId, e?.message || e
              );
              try {
                await updateDoc(botDocRef(estId), { command: "error" });
                lastCommand.set(estId, "error");
              } catch {}
            }

            continue;
          }

          // =========================================================
          // ✅ DECISÃO: só inicia Chromium quando:
          //    start=true E (watchQr ativo OU já escaneou antes)
          // =========================================================

          const numberStr = String(data.number || "").trim();
          const scannedBefore =
            data.sessionOk === true ||
            data.scanned === true ||
            (numberStr.length > 0 && numberStr.includes("@"));

          const watchActive = isWatchQrActive(data);

          const shouldRun = flagStart && (scannedBefore || watchActive);

          const prevRun = lastRunDecision.get(estId);
          if (prevRun !== shouldRun) {
            lastRunDecision.set(estId, shouldRun);

            console.log(
              "[bots supervisor] est=%s shouldRun=%s start=%s scannedBefore=%s watchActive=%s change=%s",
              estId, shouldRun, flagStart, scannedBefore, watchActive, ch.type
            );

            if (shouldRun) {
              cancelStop(estId);
              await startClientFor(estId);
            } else {
              if (!flagStart) {
                cancelStop(estId);
                await stopClientFor(estId);
              } else {
                // start=true mas sem scan e sem tela Robô -> não roda
                scheduleStop(estId);
              }
            }
          }
        }
      },
      (err) => {
        console.error("[bot supervisor] onSnapshot /bots err:", err);
      }
    );

    console.log("[bot] supervisor multi-tenant escutando /bots e watchers CG");
  }

  onClientReady(async (estId) => {
    try {
      await catchUpConfirmationsFor(estId);
    } catch (e) {
      console.error("[catch-up] erro:", e);
    }
  });
})();
