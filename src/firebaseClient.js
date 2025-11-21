// /bot/src/firebaseClient.js
import "dotenv/config";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  collectionGroup,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  runTransaction,
  increment,
} from "firebase/firestore";

/** ================== Firebase App ================== */
const app = initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);

/** ================== Auth do BOT ================== */
export async function loginBot() {
  const email = process.env.BOT_EMAIL;
  const password = process.env.BOT_PASSWORD;
  if (!email || !password) throw new Error("Defina BOT_EMAIL e BOT_PASSWORD");
  await signInWithEmailAndPassword(auth, email, password);
  return new Promise((resolve) => {
    onAuthStateChanged(auth, (u) => {
      if (u) resolve(u);
    });
  });
}

/** ================== Atalhos de coleções ================== */
export const cgAgPriv = () => collectionGroup(db, "agendamentos");
export const cgAgPub = () => collectionGroup(db, "agendamentos_publicos");

export function botDocRef(estabelecimentoId) {
  return doc(db, "bots", estabelecimentoId);
}

/** ================== Leitura de estabelecimento ================== */
export async function getEstabelecimento(estabelecimentoId) {
  if (!estabelecimentoId) return null;
  const dref = doc(db, "estabelecimentos", estabelecimentoId);
  const snap = await getDoc(dref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** (Opcional) ajuda a ler estado do bot rapidamente */
export async function getBotState(estabelecimentoId) {
  const bref = botDocRef(estabelecimentoId);
  const bsnap = await getDoc(bref);
  return bsnap.exists() ? bsnap.data() : null;
}

/** (Opcional) sinalizar comandos no doc do bot */
export async function sendBotCommand(estabelecimentoId, command, extra = {}) {
  const bref = botDocRef(estabelecimentoId);
  await updateDoc(bref, {
    command: String(command || ""),
    commandAt: serverTimestamp(),
    commandNonce: Math.random().toString(36).slice(2),
    ...extra,
  });
}

/** ================== Flags de envio (agendamentos) ================== */
export async function markConfirmSent(dref) {
  await updateDoc(dref, {
    confirmacaoEnviada: true,
    confirmacaoEnviadaEm: serverTimestamp(),
  });
}

export async function markReminderSent(dref) {
  await updateDoc(dref, {
    lembreteEnviado: true,
    lembreteEnviadoEm: serverTimestamp(),
  });
}

export async function markReviewSent(dref) {
  await updateDoc(dref, {
    reviewSent: true,
    reviewSentEm: serverTimestamp(),
  });
}

/** ================== Welcome (boas-vindas) ==================
 * Histórico por contato (wid) em:
 * /estabelecimentos/{estId}/whatsapp_welcome/{wid}
 * Compatível com as regras novas: lastSentAt (timestamp) e count (int).
 */
export async function getWelcomeDoc(estId, wid) {
  const ref = doc(db, "estabelecimentos", estId, "whatsapp_welcome", wid);
  return await getDoc(ref);
}

/** Marca envio de boas-vindas (idempotente o suficiente p/ logs):
 *  - lastSentAt = serverTimestamp()
 *  - count += 1
 */
export async function markWelcomeSent(estId, wid) {
  const ref = doc(db, "estabelecimentos", estId, "whatsapp_welcome", wid);
  await setDoc(
    ref,
    {
      lastSentAt: serverTimestamp(),
      count: increment(1),
    },
    { merge: true }
  );
}

/** (Opcional) Versão com transação/lock — use se precisar garantir
 *  consistência estrita (normalmente o whatsapp.js já faz um lock próprio).
 */
export async function txMarkWelcomeIf(estId, wid, predicateFn) {
  const ref = doc(db, "estabelecimentos", estId, "whatsapp_welcome", wid);
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? snap.data() : {};
    if (predicateFn && !(await predicateFn(current))) {
      return false;
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
}
