// whatsapp.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode";
import fs from "fs/promises";
import path from "path";

import { botDocRef, db, getEstabelecimento } from "./firebaseClient.js";
import {
  updateDoc,
  serverTimestamp,
  runTransaction,
  doc,
  increment,
} from "firebase/firestore";

/* =========================
   REGISTROS / CALLBACKS
   ========================= */
const clientsByEst = new Map();

// Callbacks disparados quando um cliente fica READY
const readyCallbacks = new Set();
export function onClientReady(cb) {
  readyCallbacks.add(cb);
  return () => readyCallbacks.delete(cb);
}

async function write(ref, data) {
  try {
    await updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
  } catch {}
}

/* =========================
   AUTH LOCAL (limpar sessão)
   ========================= */
export async function clearAuthFor(estabelecimentoId, clientId = "default") {
  const authId = `est-${estabelecimentoId}-${clientId}`;
  const base = path.resolve(process.cwd(), ".wwebjs_auth");
  const sessionDir = path.join(base, `session-${authId}`);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch {}
}

/* =========================
   HELPERS TELEFONE/WID
   ========================= */
export function toDigitsWithCountry(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 11) return `55${digits}`; // BR
  if (digits.length >= 12) return digits;         // já com DDI
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

/* =========================
   WELCOME (Boas-vindas) — de-dupe
   ========================= */

// Cache em memória por WID para reduzir hits em sequência.
// Ex.: 12 horas (43200000 ms). Ajuste via env se quiser.
const WELCOME_MEM_TTL_MS = Number(process.env.WELCOME_MEM_TTL_MS || 12 * 60 * 60 * 1000);
const welcomeMem = new Map(); // wid -> expiresAt(ms)

/** Retorna true se o WID está "recentemente saudado" no cache. */
function isWelcomeCached(wid) {
  const exp = welcomeMem.get(wid);
  if (!exp) return false;
  const now = Date.now();
  if (now < exp) return true;
  welcomeMem.delete(wid);
  return false;
}

/** Marca no cache de memória por TTL. */
function markWelcomeCache(wid) {
  welcomeMem.set(wid, Date.now() + WELCOME_MEM_TTL_MS);
}

/**
 * Garante lock transacional por período no Firestore:
 * - Caminho: /estabelecimentos/{estId}/whatsapp_welcome/{wid}
 * - Campo: lastSentAt (timestamp), count (int)
 * - Janela de reenvio configurável (padrão 12h via WELCOME_WINDOW_HOURS)
 * Retorna true se PODE enviar agora; false se já foi enviado dentro da janela.
 */
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
      if (last && now - last < windowMs) {
        return false; // dentro da janela → NÃO envia
      }
    }

    tx.set(
      ref,
      {
        lastSentAt: serverTimestamp(),
        count: increment(1),
      },
      { merge: true }
    );
    return true;
  });

  return ok;
}

/* =========================
   START CLIENT / LISTENERS
   ========================= */
export async function startClientFor(estabelecimentoId, clientId = "default") {
  if (!estabelecimentoId) throw new Error("startClientFor: estabelecimentoId ausente");
  if (clientsByEst.has(estabelecimentoId)) {
    return clientsByEst.get(estabelecimentoId);
  }

  const authId = `est-${estabelecimentoId}-${clientId}`;
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: authId }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  const ref = botDocRef(estabelecimentoId);
  clientsByEst.set(estabelecimentoId, client);

  client.on("qr", async (qrStr) => {
    try {
      const dataUrl = await qrcode.toDataURL(qrStr, { margin: 1, scale: 6 });
      await write(ref, { state: "qr", qr: dataUrl, error: "" });
      console.log("[wa] QR recebido (pronto para escanear).");
    } catch (e) {
      await write(ref, { state: "error", error: String(e?.message || e) });
    }
  });

  client.on("authenticated", async () => {
    await write(ref, { state: "authenticated", qr: "", error: "" });
  });

  client.on("ready", async () => {
    const me = client.info?.wid?._serialized || "";
    await write(ref, { state: "ready", number: me, qr: "", error: "" });
    console.log("[wa] READY. Meu WID:", me);
    for (const cb of readyCallbacks) {
      try { await cb(estabelecimentoId); } catch {}
    }
  });

  client.on("loading_screen", (pct, msg) => {
    console.log(`[wa] loading_screen ${pct}% - ${msg}`);
  });

  client.on("disconnected", async (reason) => {
    await write(ref, { state: "disconnected", error: String(reason || "") });
    try { await client.destroy(); } catch {}
    clientsByEst.delete(estabelecimentoId);
  });

  // =========================
  // INBOUND (apenas 'message')
  // =========================
  client.on("message", async (msg) => {
    try {
      // Ignore mensagens que eu mesmo enviei
      if (msg.fromMe) return;

      // Ignora grupos
      const chat = await msg.getChat().catch(() => null);
      if (chat?.isGroup) return;

      // Normaliza WID (pode vir @c.us ou @lid)
      const wid = String(msg.from || "").trim();
      if (!wid) return;

      console.log("[wa] inbound accepted →", wid);

      // Descobre o estId deste cliente atual
      const estId = estabelecimentoId; // fechado por escopo do startClientFor
      if (!estId) return;

      // Cache em memória: já saudado recentemente?
      if (isWelcomeCached(wid)) return;

      // Trava transacional (Firestore) por janela (12h por padrão)
      const allowed = await canSendWelcomeNow(estId, wid);
      if (!allowed) {
        markWelcomeCache(wid);
        return;
      }

      // -------- Mensagem de boas-vindas no formato solicitado --------
      const est = await getEstabelecimento(estId);
      const estNome = (est?.nome || "Estabelecimento").trim();

      // Base pública com fallback para markja.com.br
      const base = (process.env.PUBLIC_BASE_URL || "https://www.markja.com.br").replace(/\/+$/, "");
      const slug = (est?.slug || "").trim();
      const agendarUrl = slug ? `${base}/${slug}` : "";

      const nomeLinha = `MarkJá - ${estNome}`;

      const welcome = agendarUrl
        ? `Olá! 👋 Seja bem-vindo ao ${nomeLinha}.\n\n` +
          `Para agendar seu horário de forma rápida, toque aqui:\n` +
          `${agendarUrl}\n\n` +
          `Se precisar de ajuda, é só responder esta mensagem.`
        : `Olá! 👋 Seja bem-vindo ao ${nomeLinha}.\n\n` +
          `Se precisar de ajuda, é só responder esta mensagem.`;

      // Responde no próprio chat (funciona para @c.us e @lid)
      await msg.reply(welcome);

      // Marca cache em memória
      markWelcomeCache(wid);

    } catch (e) {
      console.warn("[WELCOME] erro ao processar mensagem de entrada:", e);
    }
  });

  await write(ref, { state: "starting", qr: "", error: "" });

  client.initialize().catch(async (e) => {
    await write(ref, { state: "error", error: String(e?.message || e) });
  });

  return client;
}

export async function stopClientFor(estabelecimentoId) {
  const c = clientsByEst.get(estabelecimentoId);
  if (!c) return;
  try { await c.destroy(); } catch {}
  clientsByEst.delete(estabelecimentoId);
  try { await write(botDocRef(estabelecimentoId), { state: "disconnected" }); } catch {}
}

export function getClientFor(estabelecimentoId) {
  return clientsByEst.get(estabelecimentoId) || null;
}
