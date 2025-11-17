// /bot/src/whatsapp.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode";
import { botDocRef } from "./firebaseClient.js";
import { updateDoc, serverTimestamp } from "firebase/firestore";

// ==== REGISTRO EM MEMÓRIA ====
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

/**
 * Sobe (ou retorna) um cliente do WhatsApp para um estabelecimento específico.
 * Atualiza /bots/{estId} com: state, qr (dataURL), number, error.
 */
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
    for (const cb of readyCallbacks) {
      try { await cb(estabelecimentoId); } catch {}
    }
  });

  client.on("disconnected", async (reason) => {
    await write(ref, { state: "disconnected", error: String(reason || "") });
    try { await client.destroy(); } catch {}
    clientsByEst.delete(estabelecimentoId);
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

/** Normaliza telefone → apenas dígitos, com DDI se faltar (BR: 55) */
export function toDigitsWithCountry(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 11) return `55${digits}`; // BR (DDD + 9 dígitos)
  if (digits.length >= 12) return digits;         // já tem DDI
  return digits;
}

/** Resolve WID de pessoa (bloqueia grupos; só @c.us) */
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
