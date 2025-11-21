// /bot/src/templates.js
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

const NOME_SISTEMA = process.env.NOME_SISTEMA || "SeuSaaS";

/** Confirmação de agendamento */
export function buildConfirmacao({ clienteNome, estabelecimentoNome, inicio, servico }) {
  const data = format(inicio, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  return `${NOME_SISTEMA} • Confirmação de Agendamento

Olá, ${clienteNome}! ✅
Seu agendamento ${servico ? `de *${servico}* ` : ""}no *${estabelecimentoNome}* está *confirmado* para ${data}.
`;
}

/** Lembrete T-2h */
export function buildLembrete({ clienteNome, estabelecimentoNome, inicio, servico }) {
  const data = format(inicio, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  return `${NOME_SISTEMA} • Lembrete

Oi, ${clienteNome}! ⏰
Lembrando do seu ${servico ? `*${servico}* ` : ""}no *${estabelecimentoNome}* hoje às ${format(
    inicio,
    "HH:mm"
  )} ( ${data} ).
`;
}

/** Mensagem de boas-vindas + link de agendamento */
export function buildWelcome({ estabelecimentoNome, agendarLink }) {
  const nome = estabelecimentoNome || "seu estabelecimento";
  const link = agendarLink || "https://www.markja.com.br/";

  return `${NOME_SISTEMA} • Atendimento automático

Olá! 👋
Você está falando com o atendimento automático do *${nome}*.

Para agendar seu horário de forma rápida, é só clicar no link abaixo:
${link}

Se preferir, pode mandar sua mensagem aqui que em breve alguém do time te responde 😊
`;
}

/** Pedido de avaliação (review) */
export function buildReviewRequest({ clienteNome, estabelecimentoNome, googleReviewLink }) {
  const nome = estabelecimentoNome || "seu atendimento";
  const link = googleReviewLink || "";

  return `${NOME_SISTEMA} • Como foi seu atendimento?

Oi${clienteNome ? `, ${clienteNome}` : ""}! 🙌
Sua experiência no *${nome}* é muito importante pra nós.

Se puder, avalie seu atendimento neste link:
${link}

Seu feedback ajuda muito a melhorar nosso serviço! 💈✨
`;
}
