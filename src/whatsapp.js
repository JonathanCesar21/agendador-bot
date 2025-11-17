// /bot/src/whatsapp.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qr from "qrcode-terminal";

export async function initWhatsapp() {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: "saas-global" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qrStr) => {
    console.log("[WA] Leia este QR (apenas na primeira vez):");
    qr.generate(qrStr, { small: true });
  });
  client.on("ready", () => console.log("[WA] ready"));
  client.on("authenticated", () => console.log("[WA] authenticated"));
  client.on("disconnected", (reason) => {
    console.error("[WA] disconnected:", reason);
  });

  await client.initialize();
  return client;
}

// E.164-ish sem o '+': 55DDDNÚMERO (apenas dígitos)
export function toDigitsWithCountry(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 11) return `55${digits}`;      // BR: DDD + 9 dígitos
  if (digits.length >= 12) return digits;              // já tem DDI
  return digits;
}

// Resolve o WID com getNumberId; se falhar, tenta fallback com isRegisteredUser
export async function resolveWid(client, rawPhone) {
  const digits = toDigitsWithCountry(rawPhone);
  if (!digits) return null;

  // 1) Tentativa preferida
  try {
    const result = await client.getNumberId(digits);
    if (result?._serialized) return result._serialized; // "55...@c.us"
  } catch (e) {
    console.warn("[WA] getNumberId falhou:", digits, e?.message);
  }

  // 2) Fallback: monta WID e valida com isRegisteredUser (se disponível)
  const wid = `${digits}@c.us`;
  try {
    if (typeof client.isRegisteredUser === "function") {
      const ok = await client.isRegisteredUser(wid);
      return ok ? wid : null;
    }
  } catch (e) {
    console.warn("[WA] isRegisteredUser falhou:", wid, e?.message);
  }

  return null;
}
