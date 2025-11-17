// /bot/src/templates.js
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

const NOME_SISTEMA = process.env.NOME_SISTEMA || "SeuSaaS";

export function buildConfirmacao({ clienteNome, estabelecimentoNome, inicio, servico }) {
  const data = format(inicio, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  return `${NOME_SISTEMA} • Confirmação de Agendamento

Olá, ${clienteNome}! ✅
Seu agendamento ${servico ? `de *${servico}* ` : ""}no *${estabelecimentoNome}* está *confirmado* para ${data}.
`;
}

export function buildLembrete({ clienteNome, estabelecimentoNome, inicio, servico }) {
  const data = format(inicio, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  return `${NOME_SISTEMA} • Lembrete

Oi, ${clienteNome}! ⏰
Lembrando do seu ${servico ? `*${servico}* ` : ""}no *${estabelecimentoNome}* hoje às ${format(inicio, "HH:mm")} ( ${data} ).
`;
}
