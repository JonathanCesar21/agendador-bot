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

import { buildWelcome as buildWelcomeTemplate } from "./templates.js";

/* =========================================================
   ESTADO GLOBAL
   ========================================================= */
const clientsByEst = new Map();     // estId -> Client
const startingByEst = new Set();    // estId em processo de start
const readyCallbacks = new Set();   // callbacks ao ficar ready
const healthchecks = new Map();     // estId -> { timer, lastOkAt }
const watchQrByEst = new Map();     // estId -> boolean (tela do robô aberta)

/** Atualizado pelo supervisor em index.js (onSnapshot /bots) */
export function setWatchQr(estabelecimentoId, value) {
  if (!estabelecimentoId) return;
  if (value === undefined) {
    watchQrByEst.delete(estabelecimentoId);
  } else {
    watchQrByEst.set(estabelecimentoId, !!value);
  }
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
  const envPath = (process.env.CHROME_PATH || "").trim();
  if (envPath && fsSync.existsSync(envPath)) return envPath;

  const candidates = [
    // Linux
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  for (const p of candidates) {
    try {
      if (fsSync.existsSync(p)) return p;
    } catch {
      // ignora e tenta o próximo
    }
  }

  console.warn("[wa] Nenhum Chrome/Chromium encontrado nas paths padrão.");
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
  return [
    path.join(base, `session-${authId}`),
    path.join(base, authId), // algumas instalações usam esse nome
  ];
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

  // Se vier só DDD + número (11 dígitos) -> prefixa 55 (Brasil)
  if (digits.length === 11) return `55${digits}`;
  // Se já tiver 12+ dígitos, assume que já está com DDI
  if (digits.length >= 12) return digits;

  return digits;
}

export async function resolveWid(client, rawPhone) {
  const digits = toDigitsWithCountry(rawPhone);
  if (!digits) return null;

  // 1) Tenta via getNumberId (forma “oficial” do wweb.js)
  try {
    const result = await client.getNumberId(digits);
    const wid = result?._serialized;
    if (wid && wid.endsWith("@c.us")) return wid;
  } catch {}

  // 2) Fallback: monta wid e, se possível, valida com isRegisteredUser
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
   WELCOME (mensagem automática de boas-vindas)
   ========================================================= */
const WELCOME_WINDOW_HOURS = Number(process.env.WELCOME_WINDOW_HOURS || 12);

function welcomeDocRef(estabelecimentoId, wid) {
  return doc(db, "estabelecimentos", estabelecimentoId, "whatsapp_welcome", wid);
}

async function canSendWelcomeNow(estabelecimentoId, wid) {
  const ref = welcomeDocRef(estabelecimentoId, wid);

  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const now = serverTimestamp();

    if (!snap.exists()) {
      tx.set(ref, { lastSentAt: now, count: increment(1) });
      return true;
    }

    const data = snap.data() || {};
    const last = data.lastSentAt?.toDate ? data.lastSentAt.toDate() : null;
    const windowMs = WELCOME_WINDOW_HOURS * 60 * 60 * 1000;

    if (!last || Date.now() - last.getTime() > windowMs) {
      tx.set(ref, { lastSentAt: now, count: increment(1) }, { merge: true });
      return true;
    }

    return false;
  });
}

const welcomeMem = new Map(); // wid -> { lastSent, estId }

function markWelcomeCache(wid, estId) {
  welcomeMem.set(wid, { lastSent: Date.now(), estId });
}

function canSendFromCache(wid, estId) {
  const entry = welcomeMem.get(wid);
  if (!entry || entry.estId !== estId) return true;
  const elapsed = Date.now() - entry.lastSent;
  const windowMs = WELCOME_WINDOW_HOURS * 60 * 60 * 1000;
  return elapsed > windowMs;
}

/**
 * Monte aqui a mensagem automática de boas-vindas
 * agora com suporte a endereço opcional
 */
function attachInboundWelcome(client, estabelecimentoId, estNome, agendarUrl, enderecoTexto) {
  if (!estabelecimentoId || !estNome || !agendarUrl) return;

  client.on("message", async (msg) => {
    try {
      if (msg.fromMe || !msg.from.endsWith("@c.us")) return;

      const wid = msg.from;
      if (!canSendFromCache(wid, estabelecimentoId)) return;
      if (!(await canSendWelcomeNow(estabelecimentoId, wid))) return;

      const welcome = buildWelcomeTemplate({
        estabelecimentoNome: estNome,
        agendarLink: agendarUrl,
        enderecoTexto,
      });

      await msg.reply(welcome);
      markWelcomeCache(wid, estabelecimentoId);
    } catch (e) {
      console.warn("[WELCOME] erro ao processar mensagem de entrada:", e?.message || e);
    }
  });
}

/* =========================================================
   STARTUP GUARD (timeout & retry)
   ========================================================= */
function makeStartupGuard({ estabelecimentoId, timeoutMs = 120000 }) {
  let fired = false;
  const cancelRef = { cancelled: false };

  const timer = setTimeout(async () => {
    if (cancelRef.cancelled) return;
    fired = true;
    console.warn("[wa] startup timeout est:", estabelecimentoId);
  }, timeoutMs);

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
    },
  };
}

// Desconexões “fatais”
const FATAL_DISCONNECT_RE = /(not-logged-in|invalid-session|auth|restart-required)/i;

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

    const execPath = detectChromePath();

    const guard = makeStartupGuard({ estabelecimentoId });

    await writeSafe(ref, { state: "starting", error: "", qr: "" });

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `est-${estabelecimentoId}-${clientId}`,
      }),
      puppeteer: {
        headless: true,
        executablePath: execPath || undefined,
        args: chromeLaunchArgs(),
      },
    });

    clientsByEst.set(estabelecimentoId, client);

    guard.progress();

    // welcome (puxa dados do estabelecimento)
    try {
      const est = await getEstabelecimento(estabelecimentoId);
      const estNome = est?.nome || "Seu estabelecimento";
      const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      const slug = est?.slug || "";
      const agendarUrl = baseUrl && slug ? `${baseUrl}/${slug}` : "";

      // flag de config que você mencionou
      const incluirEndereco =
        est?.config?.incluirEnderecoMensagemAuto === true ||
        est?.incluirEnderecoMensagemAuto === true;

      let enderecoTexto = "";

      if (incluirEndereco) {
        // tenta pegar de alguns campos mais prováveis,
        // ajusta aqui conforme o que você realmente usa no /estabelecimentos
        enderecoTexto =
          est?.enderecoMensagem ||
          est?.enderecoCompleto ||
          est?.endereco ||
          [
            est?.enderecoLogradouro || est?.rua,
            est?.enderecoNumero || est?.numero,
            est?.enderecoBairro || est?.bairro,
            (est?.enderecoCidade || est?.cidade) &&
            (est?.enderecoUf || est?.uf)
              ? `${est?.enderecoCidade || est?.cidade}/${est?.enderecoUf || est?.uf}`
              : est?.enderecoCidade || est?.cidade || "",
          ]
            .filter(Boolean)
            .join(", ");
      }

      // se não montou nada, deixa string vazia e o template simplesmente não mostra
      attachInboundWelcome(client, estabelecimentoId, estNome, agendarUrl, enderecoTexto || "");
    } catch (e) {
      console.warn("[wa] erro ao configurar welcome:", e?.message || e);
    }

    const progress = async (patch) => { guard.progress(); await writeSafe(ref, patch); };

    client.on("qr", async (qrStr) => {
      try {
        // mantém o guard vivo sempre que o WhatsApp gerar um QR
        guard.progress();

        const watch = watchQrByEst.get(estabelecimentoId);
        if (watch === false) {
          console.log("[wa] QR gerado, mas watchQr=false; não escrevendo no Firestore.");
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
      await progress({ state: "authenticated", qr: "", error: "" });
    });

    client.on("ready", async () => {
      startingByEst.delete(estabelecimentoId);
      guard.cancel();

      let number = "";
      try {
        const info = await client.getMe();
        if (info?.id?._serialized) number = info.id._serialized;
      } catch {}

      await writeSafe(ref, { state: "ready", error: "", qr: "", number });

      startHealthcheck(estabelecimentoId, client);

      readyCallbacks.forEach((cb) => {
        try { cb(estabelecimentoId); } catch {}
      });
    });

    client.on("auth_failure", async (msg) => {
      console.warn("[wa] auth_failure est=%s msg=%s", estabelecimentoId, msg);
      await writeSafe(ref, { state: "error", error: "auth-failure", qr: "" });
      try { await client.destroy(); } catch {}
      stopHealthcheck(estabelecimentoId);
      clientsByEst.delete(estabelecimentoId);

      if (attempt < 2) {
        attempt = 2;
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

      if (FATAL_DISCONNECT_RE.test(m) || m.toLowerCase().includes("navigation")) {
        try { await clearAuthFor(estabelecimentoId, clientId); } catch {}
        attempt = Math.max(attempt, 2);
        return boot(true);
      }

      if (attempt < 1) {
        attempt = 1;
        return boot(false);
      }
    });

    client.on("change_state", async (state) => {
      const s = String(state || "");
      if (s) console.log("[wa] change_state:", s);
      // não grava em /bots aqui para evitar flood de writes; apenas mantém o guard vivo
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

    try {
      await client.initialize();
    } catch (e) {
      console.error("[wa] initialize erro:", e?.message || e);
      await writeSafe(ref, { state: "error", error: String(e?.message || e), qr: "" });
      startingByEst.delete(estabelecimentoId);
      guard.cancel();
      clientsByEst.delete(estabelecimentoId);
    }

    return client;
  }

  const c = await boot(false);
  return c;
}

export async function stopClientFor(estabelecimentoId) {
  const client = clientsByEst.get(estabelecimentoId);
  if (client) {
    try { await client.destroy(); } catch {}
    clientsByEst.delete(estabelecimentoId);
  }
  stopHealthcheck(estabelecimentoId);
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
