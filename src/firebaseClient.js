// /bot/src/firebaseClient.js
import "dotenv/config";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged
} from "firebase/auth";
import {
  getFirestore,
  collectionGroup,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp
} from "firebase/firestore";

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

// Helpers “equivalentes” aos do Admin:
export const cgAgPriv = () => collectionGroup(db, "agendamentos");
export const cgAgPub  = () => collectionGroup(db, "agendamentos_publicos");

export async function getEstabelecimento(estabelecimentoId) {
  if (!estabelecimentoId) return null;
  const dref = doc(db, "estabelecimentos", estabelecimentoId);
  const snap = await getDoc(dref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function markConfirmSent(dref) {
  await updateDoc(dref, {
    confirmacaoEnviada: true,
    confirmacaoEnviadaEm: serverTimestamp()
  });
}

export async function markReminderSent(dref) {
  await updateDoc(dref, {
    lembreteEnviado: true,
    lembreteEnviadoEm: serverTimestamp()
  });
}