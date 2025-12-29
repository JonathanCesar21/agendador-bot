// src/whatsapp.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode";

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

import {
  botDocRef,
  db,
  getEstabelecimento,
  getWelcomeDoc,
  markWelcomeSent,
} from "./firebaseClient.js";

import { updateDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { buildWelcome as buildWelcomeTemplate } from "./templates.js";

/* =========================================================
   ESTADO GLOBAL
   ========================================================= */
const clientsByEst = new Map(); // estId -> Client
const startingByEst = new Set(); // estId em processo de start
const readyCallbacks = new Set(); // callbacks ao ficar ready
const healthchecks = new Map(); // estId -> { timer, lastOkAt }
const watchQrByEst = new Map(); // estId -> boolean (tela do robô aberta)
const readyAtByEst = new Map(); // estId -> timestamp (ms)

/** Atualizado pelo supervisor em index.js (onSnapshot /bots) */
export function setWatchQr(estabelecimentoId, value) {
  if (!estabelecimentoId) return;
  if (value === undefined) watchQrByEst.delete(estabelecimentoId);
  else watchQrByEst.set(estabelecimentoId, !!value);
}

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
   DETECÇÃO DE CHROME/CHROMIUM
   ========================================================= */
function detectChromePath() {
  const envPath =
    (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || "").trim();
  if (envPath && fsSync.existsSync(envPath)) return envPath;

  const candidates = [
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  for (const p of candidates) {
    try {
      if (fsSync.existsSync(p)) return p;
    } catch {}
  }

  return null;
}

/* =========================================================
   ARGS DE LAUNCH DO CHROME
   ========================================================= */
function chromeLaunchArgs() {
  const base = [
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
  ];

  const extra = (process.env.PUPPETEER_ARGS || "").trim();
  if (!extra) return base;

  return base.concat(
    extra
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/* =========================================================
   SESSÃO (LocalAuth)
   ========================================================= */
function sessionDirPath(estabelecimentoId, clientId = "default") {
  const authId = `est-${estabelecimentoId}-${clientId}`;
  const base = path.resolve(process.cwd(), ".wwebjs_auth");
  return [path.join(base, `session-${authId}`), path.join(base, authId)];
}

function hasSavedSession(estabelecimentoId, clientId = "default") {
  const paths = sessionDirPath(estabelecimentoId, clientId);
  return paths.some((p) => {
    try {
      return fsSync.existsSync(p);
    } catch {
      return false;
    }
  });
}

async function clearAuthFor(estabelecimentoId, clientId = "default") {
  const paths = sessionDirPath(estabelecimentoId, clientId);
  for (const p of paths) {
    try {
      if (fsSync.existsSync(p)) {
        console.log("[wa] Limpando sessão em:", p);
        await fs.rm(p, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn("[wa] clearAuthFor erro para", p, e?.message || e);
    }
  }
}

/* =========================================================
   HELPERS TELEFONE/WID
   ========================================================= */
export function toDigitsWithCountry(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return null;

  if (digits.length === 11) return `55${digits}`;
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
   HEALTHCHECK
   ========================================================= */
function startHealthcheck(estId, client) {
  stopHealthcheck(estId);

  const GRACE_MS = Number(process.env.HC_GRACE_MS || 120000);
  const intervalMs = Number(process.env.HC_INTERVAL_MS || 30000);
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
   WELCOME (boas-vindas inbound) — com fila pre-ready
   ========================================================= */
const WELCOME_COOLDOWN_HOURS = Number(
  process.env.WELCOME_COOLDOWN_HOURS ||
    process.env.WELCOME_WINDOW_HOURS ||
    12
);
const WELCOME_COOLDOWN_MS = WELCOME_COOLDOWN_HOURS * 60 * 60 * 1000;

const WELCOME_MAX_BACKLOG_HOURS = Number(process.env.WELCOME_MAX_BACKLOG_HOURS || 48);
const WELCOME_MAX_BACKLOG_MS = WELCOME_MAX_BACKLOG_HOURS * 60 * 60 * 1000;

const WELCOME_IGNORE_BEFORE_READY_MS = Number(
  process.env.WELCOME_IGNORE_BEFORE_READY_MS || 120000
);

const welcomeMem = new Map();
const welcomeMemKey = (estId, wid) => `${estId}|${wid}`;

function canSendFromMem(estId, wid) {
  const key = welcomeMemKey(estId, wid);
  const last = welcomeMem.get(key) || 0;
  if (!last) return true;
  return Date.now() - last > WELCOME_COOLDOWN_MS;
}

function markWelcomeInMem(estId, wid) {
  const key = welcomeMemKey(estId, wid);
  welcomeMem.set(key, Date.now());
}

const welcomeCtxByEst = new Map(); // estId -> { estNome, agendarUrl, enderecoTexto }
const preReadyQueueByEst = new Map(); // estId -> Map<wid, { wid, msg, msgTsMs, queuedAt }>

function queuePreReadyMessage(estId, wid, msg, msgTsMs) {
  let m = preReadyQueueByEst.get(estId);
  if (!m) {
    m = new Map();
    preReadyQueueByEst.set(estId, m);
  }
  const prev = m.get(wid);
  if (!prev || (msgTsMs || 0) >= (prev.msgTsMs || 0)) {
    m.set(wid, { wid, msg, msgTsMs, queuedAt: Date.now() });
  }
}

async function sendWelcomeText({ client, wid, text, replyMsg }) {
  try {
    if (replyMsg && typeof replyMsg.reply === "function") {
      await replyMsg.reply(text);
      return;
    }
  } catch {}
  await client.sendMessage(wid, text);
}

async function sendWelcomeIfAllowed({ client, estId, wid, msg, msgTsMs, ctx, allowReply = true }) {
  const now = Date.now();

  if (msgTsMs && now - msgTsMs > WELCOME_MAX_BACKLOG_MS) {
    console.log(
      "[WELCOME] ignorando msg muito antiga (> %d h) est=%s wid=%s",
      WELCOME_MAX_BACKLOG_HOURS,
      estId,
      wid
    );
    return;
  }

  if (!canSendFromMem(estId, wid)) {
    console.log("[WELCOME] cooldown memória, skip est=%s wid=%s", estId, wid);
    return;
  }

  try {
    const snap = await getWelcomeDoc(estId, wid);
    const data = snap.exists() ? snap.data() || {} : null;
    const lastSentMs = data?.lastSentAt?.toDate ? data.lastSentAt.toDate().getTime() : 0;

    if (lastSentMs && now - lastSentMs < WELCOME_COOLDOWN_MS) {
      markWelcomeInMem(estId, wid);
      console.log("[WELCOME] já enviado recentemente no Firestore, skip est=%s wid=%s", estId, wid);
      return;
    }
  } catch (e) {
    console.warn(
      "[WELCOME] getWelcomeDoc falhou (segue só memória) est=%s wid=%s err=%s",
      estId,
      wid,
      e?.message || e
    );
  }

  const welcome = buildWelcomeTemplate({
    estabelecimentoNome: ctx?.estNome || "Seu estabelecimento",
    agendarLink: ctx?.agendarUrl || undefined,
    enderecoTexto: ctx?.enderecoTexto || "",
  });

  await sendWelcomeText({
    client,
    wid,
    text: welcome,
    replyMsg: allowReply ? msg : null,
  });

  markWelcomeInMem(estId, wid);
  console.log("[WELCOME] OK → est=%s wid=%s", estId, wid);

  try {
    await markWelcomeSent(estId, wid);
  } catch (e) {
    console.warn("[WELCOME] markWelcomeSent falhou est=%s wid=%s err=%s", estId, wid, e?.message || e);
  }
}

async function flushPreReadyQueue(estId, client) {
  const q = preReadyQueueByEst.get(estId);
  if (!q || q.size === 0) return;

  preReadyQueueByEst.delete(estId);

  const ctx = welcomeCtxByEst.get(estId);
  if (!ctx) return;

  const items = Array.from(q.values()).sort((a, b) => (a.msgTsMs || 0) - (b.msgTsMs || 0));
  console.log("[WELCOME] flush pre-ready est=%s qtd=%d", estId, items.length);

  for (const it of items) {
    try {
      await sendWelcomeIfAllowed({
        client,
        estId,
        wid: it.wid,
        msg: it.msg,
        msgTsMs: it.msgTsMs,
        ctx,
        allowReply: false,
      });
    } catch (e) {
      console.warn("[WELCOME] flush erro est=%s wid=%s err=%s", estId, it.wid, e?.message || e);
    }
  }
}

function attachInboundWelcome(client, estabelecimentoId, estNome, agendarUrl, enderecoTexto) {
  if (!estabelecimentoId || !estNome) return;

  welcomeCtxByEst.set(estabelecimentoId, {
    estNome,
    agendarUrl,
    enderecoTexto: enderecoTexto || "",
  });

  client.on("message", async (msg) => {
    try {
      const from = msg.from || "";
      if (!from) return;

      const msgTsMs = Number(msg.timestamp || 0) * 1000;
      const tsStr = msgTsMs ? new Date(msgTsMs).toISOString() : "sem timestamp";

      console.log(
        "[DBG message] est=%s from=%s fromMe=%s type=%s ts=%s body=\"%s\"",
        estabelecimentoId,
        from,
        msg.fromMe,
        msg.type,
        tsStr,
        (msg.body || "").slice(0, 80).replace(/\s+/g, " ")
      );

      if (msg.fromMe) return;
      if (from.endsWith("@g.us") || from.includes("@broadcast")) return;

      const wid = from;

      const readyAt = readyAtByEst.get(estabelecimentoId) || 0;
      if (!readyAt) {
        queuePreReadyMessage(estabelecimentoId, wid, msg, msgTsMs);
        console.log("[WELCOME] enfileirado (pre-ready) est=%s wid=%s", estabelecimentoId, wid);
        return;
      }

      if (msgTsMs && msgTsMs < readyAt - WELCOME_IGNORE_BEFORE_READY_MS) {
        console.log(
          "[WELCOME] ignorando backlog anterior ao ready (>%dms) est=%s wid=%s msgTs=%s readyAt=%s",
          WELCOME_IGNORE_BEFORE_READY_MS,
          estabelecimentoId,
          wid,
          new Date(msgTsMs).toISOString(),
          new Date(readyAt).toISOString()
        );
        return;
      }

      const ctx = welcomeCtxByEst.get(estabelecimentoId) || {
        estNome,
        agendarUrl,
        enderecoTexto: enderecoTexto || "",
      };

      await sendWelcomeIfAllowed({
        client,
        estId: estabelecimentoId,
        wid,
        msg,
        msgTsMs,
        ctx,
        allowReply: true,
      });
    } catch (e) {
      console.warn("[WELCOME] erro:", e?.message || e);
    }
  });
}

/* =========================================================
   STARTUP GUARD
   ========================================================= */
function makeStartupGuard({ estabelecimentoId, timeoutMs = 120000 }) {
  let cancelled = false;
  let timer = null;

  const arm = () => {
    try { clearTimeout(timer); } catch {}
    timer = setTimeout(() => {
      if (cancelled) return;
      console.warn("[wa] startup timeout est:", estabelecimentoId);
    }, timeoutMs);
  };

  arm();

  return {
    touch() {
      if (cancelled) return;
      arm();
    },
    cancel() {
      cancelled = true;
      try { clearTimeout(timer); } catch {}
    },
  };
}

const FATAL_DISCONNECT_RE = /(not-logged-in|invalid-session|auth|restart-required)/i;

function isFatalAuthReason(reasonText) {
  const m = String(reasonText || "");
  return FATAL_DISCONNECT_RE.test(m);
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

  let attempt = 0;

  async function cleanup(estId, client) {
    try { await client?.destroy?.(); } catch {}
    stopHealthcheck(estId);
    clientsByEst.delete(estId);
    readyAtByEst.delete(estId);
    preReadyQueueByEst.delete(estId);
    welcomeCtxByEst.delete(estId);
    startingByEst.delete(estId); // ✅ evita ficar travado em "starting"
  }

  async function boot(useFreshSession = false) {
    if (useFreshSession) {
      try { await clearAuthFor(estabelecimentoId, clientId); } catch {}
    }

    const execPath = detectChromePath();
    const guard = makeStartupGuard({ estabelecimentoId });

    await writeSafe(ref, { state: "starting", error: "", qr: "" });

    const puppeteerCfg = {
      headless: true,
      args: chromeLaunchArgs(),
      ...(execPath ? { executablePath: execPath } : {}),
      ...(process.env.PUPPETEER_DUMPIO === "1" ? { dumpio: true } : {}),
    };

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `est-${estabelecimentoId}-${clientId}`,
      }),
      puppeteer: puppeteerCfg,
    });

    clientsByEst.set(estabelecimentoId, client);

    // welcome
    try {
      const est = await getEstabelecimento(estabelecimentoId);
      const estNome = est?.nome || "Seu estabelecimento";
      const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const slug = est?.slug || "";
      const agendarUrl = baseUrl && slug ? `${baseUrl}/${slug}` : "";

      const incluirEndereco =
        est?.config?.incluirEnderecoMensagemAuto === true ||
        est?.incluirEnderecoMensagemAuto === true;

      let enderecoTexto = "";

      if (incluirEndereco) {
        enderecoTexto =
          est?.enderecoMensagem ||
          est?.enderecoCompleto ||
          est?.endereco ||
          [
            est?.enderecoLogradouro || est?.rua,
            est?.enderecoNumero || est?.numero,
            est?.enderecoBairro || est?.bairro,
            (est?.enderecoCidade || est?.cidade) && (est?.enderecoUf || est?.uf)
              ? `${est?.enderecoCidade || est?.cidade}/${est?.enderecoUf || est?.uf}`
              : est?.enderecoCidade || est?.cidade || "",
          ]
            .filter(Boolean)
            .join(", ");
      }

      attachInboundWelcome(client, estabelecimentoId, estNome, agendarUrl, enderecoTexto || "");
    } catch (e) {
      console.warn("[wa] erro ao configurar welcome:", e?.message || e);
    }

    const progress = async (patch) => {
      guard.touch();
      await writeSafe(ref, patch);
    };

    client.on("qr", async (qrStr) => {
      try {
        guard.touch();

        const watch = watchQrByEst.get(estabelecimentoId);

        // ✅ só escreve QR quando a tela do robô estiver aberta
        if (watch !== true) {
          console.log("[wa] QR gerado, mas watchQr!=true; não escrevendo no Firestore.");
          return;
        }

        const dataUrl = await qrcode.toDataURL(qrStr, { margin: 1, scale: 6 });
        await writeSafe(ref, { state: "qr", qr: dataUrl, error: "" });
        console.log("[wa] QR recebido (pronto para escanear).");
      } catch (e) {
        await writeSafe(ref, { state: "error", error: String(e?.message || e), qr: "" });
      }
    });

    client.on("authenticated", async () => {
      // ✅ marca “sessão ok” (scaneou/logou)
      await progress({ state: "authenticated", qr: "", error: "", sessionOk: true });
    });

    client.on("loading_screen", () => {
      guard.touch();
    });

    client.on("change_state", async (state) => {
      const s = String(state || "");
      if (s) console.log("[wa] change_state:", s);
      guard.touch();
    });

    client.on("ready", async () => {
      guard.cancel();

      const now = Date.now();
      readyAtByEst.set(estabelecimentoId, now);
      console.log("[wa] client READY est=%s readyAt=%s", estabelecimentoId, new Date(now).toISOString());

      let number = "";
      try {
        const info = await client.getMe();
        if (info?.id?._serialized) number = info.id._serialized;
      } catch {}

      // ✅ ready -> definitivamente “já conectou”
      await writeSafe(ref, {
        state: "ready",
        error: "",
        qr: "",
        number,
        sessionOk: true,
        scanned: true,
      });

      try {
        await flushPreReadyQueue(estabelecimentoId, client);
      } catch (e) {
        console.warn("[WELCOME] flushPreReadyQueue falhou:", e?.message || e);
      }

      startHealthcheck(estabelecimentoId, client);

      startingByEst.delete(estabelecimentoId); // ✅ libera
      readyCallbacks.forEach((cb) => {
        try { cb(estabelecimentoId); } catch {}
      });
    });

    client.on("error", async (err) => {
      const m = String(err?.message || err || "");
      console.warn("[wa] error:", m);

      // ✅ se for erro fatal de auth, não ficar “loopando chromium”
      if (isFatalAuthReason(m)) {
        const watch = watchQrByEst.get(estabelecimentoId) === true;

        try { await clearAuthFor(estabelecimentoId, clientId); } catch {}
        await writeSafe(ref, {
          state: "disconnected",
          error: "Sessão expirada/invalidada. Abra a tela do Robô para gerar um novo QR.",
          qr: "",
          sessionOk: false,
          scanned: false,
          number: "",
        });

        await cleanup(estabelecimentoId, client);

        // Só tenta subir novamente se a tela do robô estiver aberta
        if (watch) {
          attempt = Math.max(attempt, 2);
          return boot(true);
        }
        return;
      }

      await writeSafe(ref, { state: "disconnected", error: m, qr: "" });
      await cleanup(estabelecimentoId, client);

      // retry leve p/ erros transitórios
      if (attempt < 1) {
        attempt = 1;
        return boot(false);
      }
    });

    client.on("disconnected", async (reason) => {
      const msg = String(reason || "");
      console.warn("[wa] disconnected:", msg);

      // ✅ se for fatal auth, não loopar; espera watchQr=true
      if (isFatalAuthReason(msg)) {
        const watch = watchQrByEst.get(estabelecimentoId) === true;

        try { await clearAuthFor(estabelecimentoId, clientId); } catch {}
        await writeSafe(ref, {
          state: "disconnected",
          error: "Sessão expirada/invalidada. Abra a tela do Robô para gerar um novo QR.",
          qr: "",
          sessionOk: false,
          scanned: false,
          number: "",
        });

        await cleanup(estabelecimentoId, client);

        if (watch) {
          attempt = Math.max(attempt, 2);
          return boot(true);
        }
        return;
      }

      await writeSafe(ref, { state: "disconnected", error: msg, qr: "" });
      await cleanup(estabelecimentoId, client);

      if (attempt < 1) {
        attempt = 1;
        return boot(false);
      }
    });

    try {
      guard.touch();
      await client.initialize();
      guard.touch();
    } catch (e) {
      const errTxt = String(e?.stack || e?.message || e);
      console.error("[wa] initialize erro:", errTxt);

      await writeSafe(ref, { state: "error", error: errTxt, qr: "" });
      guard.cancel();
      await cleanup(estabelecimentoId, client);
    }

    return client;
  }

  return await boot(false);
}

export async function stopClientFor(estabelecimentoId) {
  const client = clientsByEst.get(estabelecimentoId);
  if (client) {
    try { await client.destroy(); } catch {}
    clientsByEst.delete(estabelecimentoId);
  }
  stopHealthcheck(estabelecimentoId);
  readyAtByEst.delete(estabelecimentoId);
  preReadyQueueByEst.delete(estabelecimentoId);
  welcomeCtxByEst.delete(estabelecimentoId);
  startingByEst.delete(estabelecimentoId);

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
