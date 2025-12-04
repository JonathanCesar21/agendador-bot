// src/handlers.js
import { buildConfirmacao, buildLembrete } from "./templates.js";
import {
  getEstabelecimento,
  markConfirmSent,
  markReminderSent,
  db,
  getWelcomeDoc,
  markWelcomeSent,
} from "./firebaseClient.js";
import {
  collectionGroup,
  getDocs,
  query,
  where,
  orderBy,
  Timestamp,
} from "firebase/firestore";
import { getClientFor, resolveWid } from "./whatsapp.js";

// ====== Configuração/cooldown em memória ======
const memWelcome = new Map(); // key: estId|wid  -> lastSent (ms)
const WELCOME_COOLDOWN_MIN = Number(
  process.env.WELCOME_COOLDOWN_MINUTES ?? 360 // 6h
);

export function parseBooking(snap) {
  const data = snap.data() || {};
  let inicio = data.inicio;
  if (inicio?.toDate) inicio = inicio.toDate();
  const telefone = data.clienteTelefone || data.telefone || data.whatsapp;
  return {
    ref: snap.ref,
    id: snap.id,
    estabelecimentoId: data.estabelecimentoId,
    clienteNome: data.clienteNome || data.nome || "cliente",
    clienteTelefone: telefone,
    profissional: data.profissional,
    servico: data.servico,
    status: data.status,
    inicio,
    confirmacaoEnviada: !!data.confirmacaoEnviada,
    lembreteEnviado: !!data.lembreteEnviado,
  };
}

function allowedStatuses() {
  return (process.env.CONFIRM_SEND_ON_STATUS || "agendado,confirmado")
    .split(",")
    .map((s) => s.trim());
}

/** ========== CONFIRMAÇÃO ========== */
export async function maybeSendConfirm({ booking }) {
  const allowed = allowedStatuses();
  if (!booking?.inicio || !booking?.clienteTelefone) return;
  if (booking.confirmacaoEnviada) return;
  if (!allowed.includes(String(booking.status || ""))) return;

  const waClient = getClientFor(booking.estabelecimentoId);
  if (!waClient) {
    console.warn("[CONFIRM] skip: WA client não conectado para est:", booking.estabelecimentoId);
    return;
  }

  const est = await getEstabelecimento(booking.estabelecimentoId);
  const msg = buildConfirmacao({
    clienteNome: booking.clienteNome || booking.nomeCliente || "Cliente",
    estabelecimentoNome: est?.nome || "Seu estabelecimento",
    inicio: booking.inicio?.toDate ? booking.inicio.toDate() : booking.inicio,
    servico: booking.servicoNome || booking.servico || "",
    incluirEnderecoMensagemAuto: !!est?.incluirEnderecoMensagemAuto,
    rua: est?.rua,
    numero: est?.numero,
    bairro: est?.bairro,
    cidade: est?.cidade,
    uf: est?.uf,
    referencia: est?.referencia,
    cep: est?.cep,
  });

  const wid = await resolveWid(waClient, booking.clienteTelefone);
  if (!wid || !wid.endsWith("@c.us")) {
    console.warn("[CONFIRM] skip: WID inválido ou grupo:", wid, "tel:", booking.clienteTelefone);
    return;
  }

  await waClient.sendMessage(wid, msg);
  await markConfirmSent(booking.ref);
  console.log("[CONFIRM] OK →", wid, booking.id);
}

/** ========== LEMBRETE (cron T-2h) ========== */
export async function sendReminder({ booking }) {
  if (!booking?.inicio || !booking?.clienteTelefone) return;
  if (booking.lembreteEnviado) return;

  const waClient = getClientFor(booking.estabelecimentoId);
  if (!waClient) return;

  const est = await getEstabelecimento(booking.estabelecimentoId);
  const msg = buildLembrete({
    clienteNome: booking.clienteNome || booking.nomeCliente || "Cliente",
    estabelecimentoNome: est?.nome || "Seu estabelecimento",
    inicio: booking.inicio?.toDate ? booking.inicio.toDate() : booking.inicio,
    servico: booking.servicoNome || booking.servico || "",
    incluirEnderecoMensagemAuto: !!est?.incluirEnderecoMensagemAuto,
    rua: est?.rua,
    numero: est?.numero,
    bairro: est?.bairro,
    cidade: est?.cidade,
    uf: est?.uf,
    referencia: est?.referencia,
    cep: est?.cep,
  });

  const wid = await resolveWid(waClient, booking.clienteTelefone);
  if (!wid || !wid.endsWith("@c.us")) {
    console.warn("[REMINDER] skip: WID inválido/grupo:", wid, "tel:", booking.clienteTelefone);
    return;
  }

  await waClient.sendMessage(wid, msg);
  await markReminderSent(booking.ref);
  console.log("[REMINDER] OK →", wid, booking.id);
}

/** ========== CATCH-UP confs recentes quando READY ========== */
export async function catchUpConfirmationsFor(estId) {
  const allowed = allowedStatuses();
  const since = Timestamp.fromDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));

  async function runOnGroup(groupName) {
    const q = query(
      collectionGroup(db, groupName),
      where("estabelecimentoId", "==", estId),
      where("criadoEm", ">=", since),
      orderBy("criadoEm", "asc")
    );
    const snap = await getDocs(q);
    let sent = 0;
    for (const d of snap.docs) {
      const b = parseBooking(d);
      if (!b.clienteTelefone) continue;
      if (b.confirmacaoEnviada) continue;
      if (!allowed.includes(String(b.status || ""))) continue;
      try {
        await maybeSendConfirm({ booking: b });
        sent++;
      } catch (e) {
        console.warn("[catch-up] falha ao enviar confirm para", b.id, e?.message || e);
      }
    }
    return sent;
  }

  const a = await runOnGroup("agendamentos");
  const b = await runOnGroup("agendamentos_publicos");
  console.log(`[catch-up] est=${estId} confirmações enviadas: ${a + b}`);
}

/** ========= SAUDAÇÃO (WELCOME) =========
 * Se em algum lugar você ainda usar handleIncomingMessage,
 * ele agora também lê lastSentAt (igual ao whatsapp.js).
 */
export async function handleIncomingMessage({ client, estId, msg }) {
  const from = msg?.from || "";
  if (!from || from.endsWith("@g.us")) return;

  const now = Date.now();
  const msgTsMs = Number(msg.timestamp || 0) * 1000;

  const bodyPreview = (msg.body || "").slice(0, 80).replace(/\s+/g, " ");
  console.log(
    "[WELCOME-handle] est=%s from=%s ts=%s body=\"%s\"",
    estId,
    from,
    msgTsMs ? new Date(msgTsMs).toISOString() : "sem timestamp",
    bodyPreview
  );

  if (msgTsMs && now - msgTsMs > WELCOME_COOLDOWN_MIN * 60 * 1000) {
    console.log(
      "[WELCOME-handle] ignorando msg antiga (> %d min) est=%s from=%s",
      WELCOME_COOLDOWN_MIN,
      estId,
      from
    );
    return;
  }

  const key = `${estId}|${from}`;
  const last = memWelcome.get(key) || 0;
  if (now - last < WELCOME_COOLDOWN_MIN * 60 * 1000) {
    console.log(
      "[WELCOME-handle] dentro do cooldown em memória, não respondendo est=%s from=%s",
      estId,
      from
    );
    return;
  }

  try {
    const snap = await getWelcomeDoc(estId, from);
    const d = snap.exists() ? snap.data() || {} : null;
    const lastSentMs = d?.lastSentAt?.toDate
      ? d.lastSentAt.toDate().getTime()
      : 0;

    if (lastSentMs && now - lastSentMs < WELCOME_COOLDOWN_MIN * 60 * 1000) {
      memWelcome.set(key, now);
      console.log(
        "[WELCOME-handle] já enviado recentemente no Firestore, skip est=%s from=%s",
        estId,
        from
      );
      return;
    }
  } catch (e) {
    console.warn(
      "[WELCOME-handle] read doc falhou (segue só com cache em memória):",
      e?.code || e?.message || e
    );
  }

  const est = await getEstabelecimento(estId);
  const nome = est?.nome || "seu estabelecimento";
  const slug = est?.slug;
  const publicBase =
    process.env.PUBLIC_BASE_URL || "https://www.markja.com.br";
  const linkAgenda = slug ? `${publicBase}/${slug}` : publicBase;

  const welcomeMsg =
    `Olá! 👋 Seja bem-vindo ao *${nome}*.\n\n` +
    `Para agendar seu horário de forma rápida, toque aqui:\n${linkAgenda}\n\n` +
    `Se precisar de ajuda, é só responder esta mensagem.`;

  await client.sendMessage(from, welcomeMsg);
  console.log("[WELCOME-handle] OK →", from, "est=", estId);

  memWelcome.set(key, now);
  try {
    await markWelcomeSent(estId, from);
  } catch (e) {
    console.warn(
      "[WELCOME-handle] markWelcomeSent falhou:",
      e?.code || e?.message || e
    );
  }
}

/** ========= REVIEW (T+1h do horário) ========= */
export async function sendReviewRequest({ booking }) {
  const waClient = getClientFor(booking.estabelecimentoId);
  if (!waClient) return;

  const est = await getEstabelecimento(booking.estabelecimentoId);
  const reviewLink = est?.googleReviewLink;
  if (!reviewLink) {
    console.log(
      "[REVIEW] skip: estabelecimento sem googleReviewLink est=",
      booking.estabelecimentoId
    );
    return;
  }

  const wid = await resolveWid(waClient, booking.clienteTelefone);
  if (!wid || !wid.endsWith("@c.us")) return;

  const msg =
    `Oi, ${booking.clienteNome || "tudo bem"}? 😊\n` +
    `Seu atendimento no *${est?.nome || "estabelecimento"}* foi concluído.\n` +
    `Pode nos avaliar rapidinho? Sua opinião é muito importante:\n${reviewLink}`;

  await waClient.sendMessage(wid, msg);
  console.log("[REVIEW] OK →", wid, booking.id);
}
