// /bot/src/handlers.js
import { buildConfirmacao, buildLembrete } from "./templates.js";
import { getEstabelecimento, markConfirmSent, markReminderSent, db } from "./firebaseClient.js";
import { getClientFor, resolveWid } from "./whatsapp.js";
import { collectionGroup, getDocs, query, where, orderBy, Timestamp } from "firebase/firestore";

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

/** Envio de confirmação (on-change) — idempotente */
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
  const estabelecimentoNome = est?.nome || "seu estabelecimento";
  const msg = buildConfirmacao({
    clienteNome: booking.clienteNome,
    estabelecimentoNome,
    inicio: booking.inicio,
    servico: booking.servico,
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

/** Envio de lembrete (cron T-2h) — idempotente */
export async function sendReminder({ booking }) {
  if (!booking?.inicio || !booking?.clienteTelefone) return;
  if (booking.lembreteEnviado) return;

  const waClient = getClientFor(booking.estabelecimentoId);
  if (!waClient) return;

  const est = await getEstabelecimento(booking.estabelecimentoId);
  const estabelecimentoNome = est?.nome || "seu estabelecimento";
  const msg = buildLembrete({
    clienteNome: booking.clienteNome,
    estabelecimentoNome,
    inicio: booking.inicio,
    servico: booking.servico,
  });

  const wid = await resolveWid(waClient, booking.clienteTelefone);
  if (!wid || !wid.endsWith("@c.us")) {
    console.warn("[REMINDER] skip: WID inválido ou grupo:", wid, "tel:", booking.clienteTelefone);
    return;
  }

  await waClient.sendMessage(wid, msg);
  await markReminderSent(booking.ref);
  console.log("[REMINDER] OK →", wid, booking.id);
}

/** Catch-up: quando o WA fica READY, envia confirmações pendentes recentes */
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
