// /bot/src/handlers.js
import { buildConfirmacao, buildLembrete } from "./templates.js";
import { getEstabelecimento, markConfirmSent, markReminderSent } from "./firebaseClient.js";
import { resolveWid } from "./whatsapp.js";

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
    lembreteEnviado: !!data.lembreteEnviado
  };
}

export async function maybeSendConfirm({ waClient, booking }) {
  const allowed = (process.env.CONFIRM_SEND_ON_STATUS || "agendado,confirmado")
    .split(",").map(s => s.trim());

  if (!booking.inicio || !booking.clienteTelefone) return;
  if (booking.confirmacaoEnviada) return;
  if (!allowed.includes(String(booking.status || ""))) return;

  const est = await getEstabelecimento(booking.estabelecimentoId);
  const estabelecimentoNome = est?.nome || "seu estabelecimento";
  const msg = buildConfirmacao({
    clienteNome: booking.clienteNome,
    estabelecimentoNome,
    inicio: booking.inicio,
    servico: booking.servico
  });

  const wid = await resolveWid(waClient, booking.clienteTelefone);
  if (!wid) {
    console.warn("[CONFIRM] número sem WhatsApp ou inválido:", booking.clienteTelefone, "booking:", booking.id);
    return; // não marca como enviado
  }

  await waClient.sendMessage(wid, msg);
  await markConfirmSent(booking.ref);
  console.log("[CONFIRM] OK →", wid, booking.id);
}

export async function sendReminder({ waClient, booking }) {
  if (!booking.inicio || !booking.clienteTelefone) return;
  if (booking.lembreteEnviado) return;

  const est = await getEstabelecimento(booking.estabelecimentoId);
  const estabelecimentoNome = est?.nome || "seu estabelecimento";
  const msg = buildLembrete({
    clienteNome: booking.clienteNome,
    estabelecimentoNome,
    inicio: booking.inicio,
    servico: booking.servico
  });

  const wid = await resolveWid(waClient, booking.clienteTelefone);
  if (!wid) {
    console.warn("[REMINDER] número sem WhatsApp ou inválido:", booking.clienteTelefone, "booking:", booking.id);
    return; // não marca como enviado
  }

  await waClient.sendMessage(wid, msg);
  await markReminderSent(booking.ref);
  console.log("[REMINDER] OK →", wid, booking.id);
}
