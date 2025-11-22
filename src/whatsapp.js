// src/whatsapp.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode";

import fs from "fs/promises";
import fsSync from "fs"; // existsSync
import path from "path";

import { botDocRef, db, getEstabelecimento } from "./firebaseClient.js";
import {
  updateDoc,
  setDoc,
  serverTimestamp,
  runTransaction,
  doc,
  increment,
} from "firebase/firestore";

/* =========================================================
   ESTADO GLOBAL
   ========================================================= */
const clientsByEst = new Map();     // estId -> Client
const startingByEst = new Set();    // estId em processo de start
const readyCallbacks = new Set();   // callbacks ao ficar ready
const healthchecks = new Map();     // estId -> { timer, lastOkAt }

/** Registra callback para quando um cliente ficar "ready" */
export function onClientReady(cb) {
  readyCallbacks.add(cb);
  return () => readyCallbacks.delete(cb);
}

/** Atualiza doc do bot com updatedAt, criando se não existir */
async function writeSafe(ref, data) {
  try {
    await updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
  } catch {
    try {
      await setDoc(ref, { ...data, updatedAt: serverTimestamp() }, { merge: true });
    } catch (e2) {
      console.error("[bots writeSafe] falhou:", e2?.code || e2?.message || e2);
    }
  }
}

/* =========================================================
   SESSÃO (LocalAuth)
   ========================================================= */
function sessionDirPath(estabelecimentoId, clientId = "default") {
  const authId = `est-${estabelecimentoId}-${clientId}`;
  const base = path.resolve(process.cwd(), ".wwebjs_auth");
  return [
    path.join(base, `session-${authId}`),
    path.join(base, authId), // algumas instalações usam esse nome
  ];
}

function hasSavedSession(estabelecimentoId, clientId = "default") {
  const paths = sessionDirPath(estabelecimentoId, clientId);
  return paths.some((p) => {
    try { return fsSync.existsSync(p); } catch { return false; }
  });
}

/** Limpa a pasta da sessão com segurança (Windows-friendly) */
export async function clearAuthFor(estabelecimentoId, clientId = "default") {
  const paths = sessionDirPath(estabelecimentoId, clientId);
  for (const p of paths) {
    try { await fs.rm(p, { recursive: true, force: true }); } catch {}
  }
}

/* =========================================================
   HELPERS TELEFONE/WID
   ========================================================= */
export function toDigitsWithCountry(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 11) return `55${digits}`; // BR
  if (digits.length >= 12) return digits;
  return digits;
}

export async function resolveWid(client, rawPhone) {
  const digits = toDigitsWithCountry(rawPhone);
  if (!digits) return null;

  try {
    const result = await client.getNumberId(digits);
    const wid = result?._serialized;
    if (wid && wid.endsWith("@c.us")) return wid;
  } catch {}

  const wid = `${digits}@c.us`;
  try {
    if (typeof client.isRegisteredUser === "function") {
      const ok = await client.isRegisteredUser(wid);
      return ok ? wid : null;
    }
  } catch {}

  return null;
}

/* =========================================================
   HEALTHCHECK (mantém processo saudável)
   ========================================================= */
function startHealthcheck(estId, client) {
  stopHealthcheck(estId);

  const GRACE_MS = Number(process.env.HC_GRACE_MS || 120000); // 2min
  const intervalMs = Number(process.env.HC_INTERVAL_MS || 30000); // 30s
  const ctx = { timer: null, lastOkAt: Date.now() };

  ctx.timer = setInterval(async () => {
    try {
      const s = client.getState ? await client.getState() : "unknown";
      if (s) ctx.lastOkAt = Date.now();

      if (Date.now() - ctx.lastOkAt > GRACE_MS) {
        console.warn("[hc] grace excedido — restart est=", estId);
        try { await client.destroy(); } catch {}
        clientsByEst.delete(estId);
        stopHealthcheck(estId);
        startClientFor(estId).catch(() => {});
      }
    } catch (e) {
      if (Date.now() - ctx.lastOkAt > GRACE_MS) {
        console.warn("[hc] erro + grace excedido — restart est=", estId, e?.message || e);
        try { await client.destroy(); } catch {}
        clientsByEst.delete(estId);
        stopHealthcheck(estId);
        startClientFor(estId).catch(() => {});
      }
    }
  }, intervalMs);

  healthchecks.set(estId, ctx);
  return ctx;
}

function stopHealthcheck(estId) {
  const ctx = healthchecks.get(estId);
  if (!ctx) return;
  try { clearInterval(ctx.timer); } catch {}
  healthchecks.delete(estId);
}

/* =========================================================
   WELCOME (de-dupe por janela, cache+tx)
   ========================================================= */
const WELCOME_MEM_TTL_MS = Number(
  process.env.WELCOME_MEM_TTL_MS || 12 * 60 * 60 * 1000
);
const welcomeMem = new Map(); // wid -> expiresAt(ms)

function isWelcomeCached(wid) {
  const exp = welcomeMem.get(wid);
  if (!exp) return false;
  const now = Date.now();
  if (now < exp) return true;
  welcomeMem.delete(wid);
  return false;
}

function markWelcomeCache(wid) {
  welcomeMem.set(wid, Date.now() + WELCOME_MEM_TTL_MS);
}

async function canSendWelcomeNow(estId, wid) {
  const hours = Number(process.env.WELCOME_WINDOW_HOURS || 12);
  const windowMs = hours * 60 * 60 * 1000;

  const ref = doc(db, "estabelecimentos", estId, "whatsapp_welcome", wid);
  const ok = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();

    if (snap.exists()) {
      const data = snap.data() || {};
      const last = data.lastSentAt?.toMillis ? data.lastSentAt.toMillis() : 0;
      if (last && now - last < windowMs) return false;
    }

    tx.set(
      ref,
      { lastSentAt: serverTimestamp(), count: increment(1) },
      { merge: true }
    );
    return true;
  });

  return ok;
}

/* =========================================================
   STARTUP GUARD (timeout & retry)
   ========================================================= */
function makeStartupGuard({ estId, ref, client, cancelRef, hasSession, onTimeout }) {
  const baseMs = Number(process.env.STARTUP_TIMEOUT_MS || 60000);
  const TIMEOUT_MS = hasSession
    ? Number(process.env.STARTUP_TIMEOUT_WITH_SESSION_MS || 180000)
    : baseMs;

  let fired = false;
  const timer = setTimeout(async () => {
    if (fired || cancelRef.cancelled) return;
    fired = true;
    console.warn(`[wa] startup-timeout → est=${estId} (no qr/auth/ready em ${TIMEOUT_MS}ms)`);
    try { await writeSafe(ref, { state: "error", error: "startup-timeout" }); } catch {}
    try { await client.destroy(); } catch {}
    onTimeout?.();
  }, TIMEOUT_MS);

  return {
    progress() {
      if (fired || cancelRef.cancelled) return;
      clearTimeout(timer);
      cancelRef.cancelled = true;
    },
    cancel() {
      if (!cancelRef.cancelled) {
        clearTimeout(timer);
        cancelRef.cancelled = true;
      }
    }
  };
}

// Desconexões “fatais”
const FATAL_DISCONNECT_RE =
  /(logout|auth|bad.?session|session.*conflict|multi.*device.*mismatch)/i;

/* =========================================================
   INBOUND WELCOME (resposta automática com link)
   ========================================================= */
function buildWelcomeText({ estNome, agendarUrl }) {
  return agendarUrl
    ? `Olá! 👋 Seja bem-vindo ao ${estNome}.\n\nPara agendar seu horário de forma rápida, toque aqui:\n${agendarUrl}\n\nSe precisar de ajuda, é só responder esta mensagem.`
    : `Olá! 👋 Você está falando com o *${estNome}*.\n\nEnvie sua mensagem com o serviço e horário desejado que retornamos em seguida.\n\nQualquer dúvida, estou por aqui!`;
}

/** Registra o listener de mensagens para um client recém-criado */
function attachInboundWelcome(estabelecimentoId, client) {
  client.on("message", async (msg) => {
    try {
      if (msg.fromMe) return;
      const chat = await msg.getChat().catch(() => null);
      if (chat?.isGroup) return;

      const wid = String(msg.from || "").trim();
      if (!wid) return;

      console.log("[wa] inbound accepted →", wid);

      if (isWelcomeCached(wid)) return;
      const allowed = await canSendWelcomeNow(estabelecimentoId, wid);
      if (!allowed) { markWelcomeCache(wid); return; }

      const est = await getEstabelecimento(estabelecimentoId);
      const estNome = est?.nome || "MarkJá - Agendamentos";
      const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const slug = est?.slug || "";
      const agendarUrl = base && slug ? `${base}/${slug}` : "";

      const welcome = buildWelcomeText({ estNome, agendarUrl });
      await msg.reply(welcome);
      markWelcomeCache(wid);
    } catch (e) {
      console.warn("[WELCOME] erro ao processar mensagem de entrada:", e?.message || e);
    }
  });
}

/* =========================================================
   START / STOP CLIENT
   ========================================================= */
export async function startClientFor(estabelecimentoId, clientId = "default") {
  if (!estabelecimentoId) throw new Error("startClientFor: estabelecimentoId ausente");

  if (startingByEst.has(estabelecimentoId)) return clientsByEst.get(estabelecimentoId) || null;
  if (clientsByEst.has(estabelecimentoId)) return clientsByEst.get(estabelecimentoId);

  startingByEst.add(estabelecimentoId);
  const ref = botDocRef(estabelecimentoId);

  let attempt = 0; // 0=inicial, 1=retry seco, 2=retry com limpeza de sessão

  async function boot(useFreshSession = false) {
    if (useFreshSession) {
      try { await clearAuthFor(estabelecimentoId, clientId); } catch {}
    }

    const authId = `est-${estabelecimentoId}-${clientId}`;
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: authId }),
      puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined, // opcional
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-gpu",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      },
    });

    // >>> IMPORTANTE: registrar o listener de boas-vindas <<<
    attachInboundWelcome(estabelecimentoId, client);

    clientsByEst.set(estabelecimentoId, client);
    let hcCtrl = null;
    const cancelRef = { cancelled: false };
    const hasSession = hasSavedSession(estabelecimentoId, clientId);

    const guard = makeStartupGuard({
      estId: estabelecimentoId,
      ref,
      client,
      cancelRef,
      hasSession,
      onTimeout: async () => {
        clientsByEst.delete(estabelecimentoId);
        stopHealthcheck(estabelecimentoId);

        if (attempt === 0) {
          attempt = 1;
          console.warn("[wa] startup-timeout → retry (mesma sessão) est=", estabelecimentoId);
          await writeSafe(ref, { state: "starting", error: "retry" });
          return boot(false);
        }

        if (attempt === 1) {
          attempt = 2;
          console.warn("[wa] startup-timeout → clear session & retry (novo QR) est=", estabelecimentoId);
          await writeSafe(ref, { state: "starting", error: "retry-clean" });
          return boot(true);
        }

        startingByEst.delete(estabelecimentoId);
        await writeSafe(ref, { state: "error", error: "startup-timeout-final" });
      }
    });

    const progress = async (patch) => { guard.progress(); await writeSafe(ref, patch); };

    client.on("qr", async (qrStr) => {
      try {
        const dataUrl = await qrcode.toDataURL(qrStr, { margin: 1, scale: 6 });
        await progress({ state: "qr", qr: dataUrl, error: "" });
        console.log("[wa] QR recebido (pronto para escanear).");
      } catch (e) {
        await writeSafe(ref, { state: "error", error: String(e?.message || e) });
      }
    });

    client.on("authenticated", async () => {
      await progress({ state: "authenticated", qr: "", error: "" });
    });

    client.on("ready", async () => {
      startingByEst.delete(estabelecimentoId);
      guard.cancel();

      const me = client.info?.wid?._serialized || "";
      await progress({ state: "ready", number: me, qr: "", error: "" });
      console.log("[wa] READY. Meu WID:", me);

      hcCtrl = startHealthcheck(estabelecimentoId, client);

      for (const cb of readyCallbacks) {
        try { await cb(estabelecimentoId); } catch {}
      }
    });

    client.on("auth_failure", async (msg) => {
      startingByEst.delete(estabelecimentoId);
      await writeSafe(ref, { state: "error", error: "auth_failure" });
      try { await client.destroy(); } catch {}
      stopHealthcheck(estabelecimentoId);
      clientsByEst.delete(estabelecimentoId);

      if (attempt < 2) {
        attempt = 2;
        console.warn("[wa] auth_failure → clear session & retry est=", estabelecimentoId);
        await writeSafe(ref, { state: "starting", error: "auth-failure-clean" });
        return boot(true);
      }
    });

    client.on("error", async (err) => {
      const m = String(err?.message || err || "");
      console.warn("[wa] error:", m);
      await writeSafe(ref, { state: "disconnected", error: m, qr: "" });
      try { await client.destroy(); } catch {}
      stopHealthcheck(estabelecimentoId);
      clientsByEst.delete(estabelecimentoId);

      if (FATAL_DISCONNECT_RE.test(m)) {
        if (attempt < 2) {
          attempt = 2;
          try { await clearAuthFor(estabelecimentoId, clientId); } catch {}
          return boot(true);
        }
      } else if (attempt < 1) {
        attempt = 1;
        return boot(false);
      }
    });

    client.on("change_state", async (state) => {
      const s = String(state || "");
      if (s) await writeSafe(ref, { state: s.toLowerCase() });
      guard.progress();
    });

    client.on("loading_screen", () => {
      guard.progress();
    });

    client.on("disconnected", async (reason) => {
      const msg = String(reason || "");
      console.warn("[wa] disconnected:", msg);

      await writeSafe(ref, { state: "disconnected", error: msg, qr: "" });
      try { await client.destroy(); } catch {}
      stopHealthcheck(estabelecimentoId);
      clientsByEst.delete(estabelecimentoId);

      if (FATAL_DISCONNECT_RE.test(msg) || msg.toLowerCase().includes("navigation")) {
        try { await clearAuthFor(estabelecimentoId, clientId); } catch {}
        attempt = Math.max(attempt, 2);
        return boot(true);
      }

      if (attempt < 1) {
        attempt = 1;
        return boot(false);
      }
    });

    await writeSafe(ref, { state: "starting", qr: "", error: "" });

    client.initialize().catch(async (e) => {
      const em = String(e?.message || e);
      await writeSafe(ref, { state: "error", error: em });
      try { await client.destroy(); } catch {}
      stopHealthcheck(estabelecimentoId);
      clientsByEst.delete(estabelecimentoId);

      if (attempt < 1) {
        attempt = 1;
        return boot(false);
      } else if (attempt < 2) {
        attempt = 2;
        return boot(true);
      } else {
        startingByEst.delete(estabelecimentoId);
      }
    });

    return client;
  }

  const c = await boot(false);
  return c;
}

export async function stopClientFor(estabelecimentoId) {
  const c = clientsByEst.get(estabelecimentoId);
  if (!c) {
    await writeSafe(botDocRef(estabelecimentoId), { state: "disconnected" });
    return;
  }
  try { await c.destroy(); } catch {}
  stopHealthcheck(estabelecimentoId);
  clientsByEst.delete(estabelecimentoId);
  await writeSafe(botDocRef(estabelecimentoId), { state: "disconnected" });
}

/** Para shutdown limpo do processo */
export async function stopAllClients() {
  const ids = Array.from(clientsByEst.keys());
  for (const estId of ids) {
    try { await stopClientFor(estId); } catch {}
  }
}

export function getClientFor(estabelecimentoId) {
  return clientsByEst.get(estabelecimentoId) || null;
}
