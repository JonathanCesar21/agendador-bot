// src/reviewWatcher.js
import {
  onSnapshot,
  collectionGroup,
  doc,
  updateDoc,
} from "firebase/firestore";
import { db, getEstabelecimento } from "./firebaseClient.js";
import { getClientFor, resolveWid, toDigitsWithCountry } from "./whatsapp.js";

/**
 * Monta a mensagem de review usando nome e link do estabelecimento.
 */
function buildReviewMessage({ estNome, reviewLink }) {
  // Ajuste o texto como preferir
  return (
    `💇‍♂️ Como foi seu atendimento hoje em *${estNome}*?\n` +
    `Sua opinião é muito importante! Se puder, deixe sua avaliação aqui:\n` +
    `${reviewLink}\n\n` +
    `Obrigado pela preferência! 🙏`
  );
}

/**
 * Decide se deve enviar o review para um doc alterado.
 * - Somente em "modified"
 * - status mudou para "feito"
 * - ainda não marcamos reviewSent
 */
function shouldSendReview(change) {
  if (change.type !== "modified") return false;
  const after = change.doc.data() || {};
  const before = change.oldIndex >= 0 ? change.doc._document?.data?.value?.mapValue : null; // não confiável
  // Como `before` não é exposto facilmente no SDK web, usamos heurística:
  // 1) status atual é "feito"
  // 2) e o doc NÃO tem reviewSent true
  // 3) para reduzir falsos-positivos, exigimos que o campo editado recentemente marque a finalização (opcional).
  return (
    String(after.status || "").toLowerCase() === "feito" &&
    after.reviewSent !== true
  );
}

/**
 * Marca reviewSent no documento do agendamento.
 */
async function markReviewSentAtDocRef(docRef) {
  try {
    await updateDoc(docRef, {
      reviewSent: true,
      reviewSentEm: new Date(),
    });
  } catch (e) {
    console.warn("[reviewWatcher] falha ao marcar reviewSent:", e?.message || e);
  }
}

/**
 * Tenta enviar a mensagem de review para o telefone do agendamento.
 * Requisitos:
 *  - bot do estabelecimento conectado (getClientFor(estId))
 *  - reviewLink presente em /estabelecimentos/{estId}
 */
async function trySendReview({ change }) {
  const data = change.doc.data() || {};
  const estId = data.estabelecimentoId;
  const phone = data.clienteTelefone;

  if (!estId || !phone) return;

  // Bot precisa estar pronto
  const client = getClientFor(estId);
  if (!client) {
    // Sem bot conectado → não envia (evita flood ao reconectar)
    return;
  }

  // Carrega dados do estabelecimento (obtem link e nome)
  const est = await getEstabelecimento(estId);
  const reviewLink = est?.googleReviewLink || est?.reviewLink || "";
  const estNome = est?.nome || "seu estabelecimento";

  if (!reviewLink) {
    // Sem link configurado → não envia
    return;
  }

  // Resolve o WID do cliente
  const wid = await resolveWid(client, toDigitsWithCountry(phone));
  if (!wid) return;

  // Envia
  const text = buildReviewMessage({ estNome, reviewLink });
  await client.sendMessage(wid, text, { sendSeen: false });

  // Marca no doc que o review foi enviado
  await markReviewSentAtDocRef(change.doc.ref);
}

/**
 * Cria um watcher para cada collectionGroup, ignorando o snapshot inicial.
 * Retorna a função de unsubscribe.
 */
function makeScopedWatcher(collGroupName) {
  let ready = false; // ignora o snapshot inicial
  const cg = collectionGroup(db, collGroupName);

  const unsub = onSnapshot(
    cg,
    async (snap) => {
      if (!ready) {
        // Primeira entrega do snapshot contém o estado atual (muitos "added").
        // Não processamos nada aqui para evitar flood.
        ready = true;
        return;
      }

      const changes = snap.docChanges();
      for (const ch of changes) {
        try {
          if (shouldSendReview(ch)) {
            await trySendReview({ change: ch });
          }
        } catch (e) {
          console.error(`[reviewWatcher] erro ao processar ${collGroupName}:`, e);
        }
      }
    },
    (err) => {
      console.error(`[reviewWatcher] erro snapshot ${collGroupName}:`, err);
    }
  );

  return unsub;
}

/**
 * Inicia os dois watchers (privado e público).
 * Export em formato *named* para bater com seu import no index.js
 */
export function startReviewWatcher() {
  const stopPriv = makeScopedWatcher("agendamentos");
  const stopPub  = makeScopedWatcher("agendamentos_publicos");

  // Retorna função para parar, caso queira usar no futuro
  return () => {
    try { stopPriv(); } catch {}
    try { stopPub(); } catch {}
  };
}
