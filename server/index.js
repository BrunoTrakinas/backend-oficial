// ===================================================================================
// ARQUIVO PRINCIPAL DO SERVIDOR (O "CÉREBRO" DO BEPIT)
// VERSÃO 2.0 - CONVERSA COM CONTEXTO PERSISTENTE (TABELA CONVERSAS) + FOLLOW-UPS DIRETOS
// ===================================================================================

import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { supabase } from "./lib/supabaseClient.js";
import { randomUUID } from "crypto";

// -----------------------------------------------------------------------------------
// CONFIGURAÇÃO INICIAL
// -----------------------------------------------------------------------------------
dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Variável GEMINI_API_KEY não encontrada no arquivo .env.");
  process.exit(1);
}

const application = express();
const servidorPorta = process.env.PORT || 3002;
const googleGenerativeArtificialIntelligenceClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const origensPermitidas = [
  "http://localhost:5173",
  "https://bepitnexus.netlify.app"
];

const opcoesDeCompartilhamentoEntreOrigens = {
  origin: function (origin, callback) {
    if (!origin || origensPermitidas.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Acesso negado pelo CORS."));
    }
  },
  credentials: true,
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  allowedHeaders: ["Content-Type", "Authorization"]
};

application.use(cors(opcoesDeCompartilhamentoEntreOrigens));
application.options("*", cors(opcoesDeCompartilhamentoEntreOrigens));
application.use(express.json());

// -----------------------------------------------------------------------------------
// SAÚDE DO SERVIDOR
// -----------------------------------------------------------------------------------
application.get("/health", (request, response) => {
  response.status(200).json({ ok: true, message: "Servidor BEPIT está online." });
});

// -----------------------------------------------------------------------------------
// DETECÇÃO DE INTENÇÃO DE PERGUNTA CURTA (FOLLOW-UP)
// -----------------------------------------------------------------------------------
function detectarIntencaoDeFollowUp(textoDoUsuario) {
  const t = String(textoDoUsuario || "").toLowerCase();

  const mapa = [
    { intencao: "horario", padroes: ["horário", "horario", "hora", "abre", "fecha", "funciona", "funcionamento", "que horas"] },
    { intencao: "endereco", padroes: ["onde fica", "endereço", "endereco", "localização", "localizacao", "como chegar", "fica onde"] },
    { intencao: "contato", padroes: ["contato", "telefone", "whatsapp", "whats", "ligar"] },
    { intencao: "fotos", padroes: ["foto", "fotos", "imagem", "imagens", "galeria"] },
    { intencao: "preco", padroes: ["preço", "preco", "faixa de preço", "faixa de preco", "caro", "barato", "valor", "quanto custa"] }
  ];

  for (const item of mapa) {
    for (const p of item.padroes) {
      if (t.includes(p)) return item.intencao;
    }
  }
  return "nenhuma";
}

// -----------------------------------------------------------------------------------
// ROTA PRINCIPAL DO CHAT
// -----------------------------------------------------------------------------------
application.post("/api/chat/:slugDaRegiao", async (request, response) => {
  console.log("\n--- NOVA INTERAÇÃO INICIADA ---");

  try {
    const { slugDaRegiao } = request.params;
    let { message: textoDoUsuario, conversationId } = request.body;

    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || textoDoUsuario.trim().length === 0) {
      return response.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }

    // obtém a região pelo slug
    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id, nome_regiao")
      .eq("slug", slugDaRegiao)
      .single();

    if (erroRegiao || !regiao) {
      return response.status(404).json({ error: `Região com apelido (slug) '${slugDaRegiao}' não encontrada.` });
    }

    // garante um conversationId e carrega ou cria a conversa
    if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length === 0) {
      conversationId = randomUUID();

      const { error: erroCriacaoConversa } = await supabase
        .from("conversas")
        .insert({
          id: conversationId,
          regiao_id: regiao.id,
          parceiro_em_foco: null,
          parceiros_sugeridos: [],
          ultima_pergunta_usuario: null,
          ultima_resposta_ia: null
        });

      if (erroCriacaoConversa) {
        console.error("Erro ao criar conversa:", erroCriacaoConversa);
        return response.status(500).json({ error: "Erro ao iniciar conversa." });
      }
    }

    const { data: conversaAtual, error: erroCarregarConversa } = await supabase
      .from("conversas")
      .select("id, regiao_id, parceiro_em_foco, parceiros_sugeridos")
      .eq("id", conversationId)
      .single();

    if (erroCarregarConversa || !conversaAtual) {
      return response.status(404).json({ error: "Conversa não encontrada." });
    }

    // detecção de follow-up curto antes de chamar a IA
    const intencaoFollowUp = detectarIntencaoDeFollowUp(textoDoUsuario);

    if (conversaAtual.parceiro_em_foco && intencaoFollowUp !== "nenhuma") {
      const p = conversaAtual.parceiro_em_foco;

      if (intencaoFollowUp === "horario") {
        const horario = p.horario_funcionamento ? String(p.horario_funcionamento) : "O parceiro não informou horário de funcionamento. Recomendo ligar antes de ir.";
        const respostaDireta = `Horário de funcionamento de ${p.nome}: ${horario}`;

        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaDireta,
          parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
        });

        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(p.link_fotos) ? p.link_fotos : [],
          conversationId: conversationId
        });
      }

      if (intencaoFollowUp === "endereco") {
        const endereco = p.endereco ? String(p.endereco) : "Endereço não informado.";
        const respostaDireta = `Endereço de ${p.nome}: ${endereco}`;

        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaDireta,
          parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
        });

        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(p.link_fotos) ? p.link_fotos : [],
          conversationId: conversationId
        });
      }

      if (intencaoFollowUp === "contato") {
        const contato = p.contato_telefone ? String(p.contato_telefone) : "Contato não informado.";
        const respostaDireta = `Contato de ${p.nome}: ${contato}`;

        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaDireta,
          parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
        });

        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(p.link_fotos) ? p.link_fotos : [],
          conversationId: conversationId
        });
      }

      if (intencaoFollowUp === "fotos") {
        const temFotos = Array.isArray(p.link_fotos) && p.link_fotos.length > 0;
        const respostaDireta = temFotos
          ? `Aqui estão algumas fotos de ${p.nome}.`
          : `Não encontrei fotos de ${p.nome}.`;

        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaDireta,
          parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
        });

        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: temFotos ? p.link_fotos : [],
          conversationId: conversationId
        });
      }

      if (intencaoFollowUp === "preco") {
        const preco = p.faixa_preco ? String(p.faixa_preco) : "Faixa de preço não informada.";
        const respostaDireta = `Faixa de preço de ${p.nome}: ${preco}`;

        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaDireta,
          parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
        });

        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(p.link_fotos) ? p.link_fotos : [],
          conversationId: conversationId
        });
      }
    }

    // se intenção foi follow-up, mas não temos parceiro em foco e há vários sugeridos, peça desambiguação
    if (!conversaAtual.parceiro_em_foco && intencaoFollowUp !== "nenhuma" && Array.isArray(conversaAtual.parceiros_sugeridos) && conversaAtual.parceiros_sugeridos.length > 1) {
      const nomes = conversaAtual.parceiros_sugeridos.map((x) => x.nome).slice(0, 5).join(", ");
      const respostaDireta = `Você está se referindo a qual parceiro: ${nomes}?`;

      await supabase.from("interacoes").insert({
        regiao_id: regiao.id,
        conversation_id: conversationId,
        pergunta_usuario: textoDoUsuario,
        resposta_ia: respostaDireta,
        parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
      });

      return response.status(200).json({
        reply: respostaDireta,
        interactionId: null,
        photoLinks: [],
        conversationId: conversationId
      });
    }

    // chama o modelo da ia
    const modeloGenerativo = googleGenerativeArtificialIntelligenceClient.getGenerativeModel({ model: "gemini-1.5-flash" });

    // extrai palavras-chave de forma robusta
    const promptParaExtrairPalavrasChave = `
sua tarefa é extrair até 3 palavras-chave de turismo da frase abaixo.
regras:
- responda apenas com as palavras separadas por vírgula.
- tudo em minúsculas.
- sem explicações.
- se não encontrar nenhuma tag, responda "geral".
exemplo: "onde comer uma pizza boa?" -> "pizza, restaurante, comer"

frase: "${textoDoUsuario}"
`.trim();

    const resultadoDePalavrasChave = await modeloGenerativo.generateContent(promptParaExtrairPalavrasChave);
    const textoDePalavrasChave = (await resultadoDePalavrasChave.response.text()).trim();

    const primeiraLinha = (textoDePalavrasChave.split("\n")[0] || "").replace(/["'“”‘’]/g, "");
    const palavrasChaveBasicas = primeiraLinha
      .split(",")
      .map((p) => (p || "").toLowerCase().trim())
      .filter((p) => p.length > 0);

    const palavrasChaveBase = palavrasChaveBasicas.length > 0 ? palavrasChaveBasicas.slice(0, 5) : ["geral"];

    // gera variações simples singular/plural, deduplica e limpa
    const palavrasChaveExpandidas = Array.from(
      new Set([
        ...palavrasChaveBase,
        ...palavrasChaveBase.map((p) => (p.endsWith("s") ? p.slice(0, -1) : `${p}s`))
      ])
    )
      .map((p) => p.trim())
      .filter((p) => p.length >= 3);

    console.log("[LOG] Palavras-chave finais:", palavrasChaveExpandidas);

    // consulta parceiros usando overlaps em tags e ilike em categoria
    let consultaParceiros = supabase
      .from("parceiros")
      .select("id, nome, categoria, descricao, beneficio_bepit, endereco, faixa_preco, contato_telefone, horario_funcionamento, link_fotos, tags")
      .eq("regiao_id", regiao.id);

    let parceiros = [];
    let erroParceiros = null;

    if (palavrasChaveExpandidas.length > 0) {
      const arrayComAspas = palavrasChaveExpandidas.map((k) => `"${k}"`).join(",");
      const partesOr = [`tags.ov.{${arrayComAspas}}`];
      for (const k of palavrasChaveExpandidas) {
        partesOr.push(`categoria.ilike.%${k}%`);
      }
      const filtroOr = partesOr.join(",");

      const resultado = await consultaParceiros.or(filtroOr);
      parceiros = resultado.data || [];
      erroParceiros = resultado.error || null;
      console.log("[LOG] Filtro OR usado:", filtroOr);
    } else {
      const resultado = await consultaParceiros;
      parceiros = resultado.data || [];
      erroParceiros = resultado.error || null;
    }

    if (erroParceiros) {
      console.error("Erro ao buscar parceiros:", erroParceiros);
      return response.status(500).json({ error: "Falha ao consultar parceiros." });
    }

    // define parceiro em foco e parceiros sugeridos
    let parceiroEmFoco = null;
    if (Array.isArray(parceiros) && parceiros.length > 0) {
      parceiroEmFoco = parceiros[0];
    }

    const { error: erroAtualizarConversa } = await supabase
      .from("conversas")
      .update({
        parceiro_em_foco: parceiroEmFoco,
        parceiros_sugeridos: Array.isArray(parceiros) ? parceiros : []
      })
      .eq("id", conversationId);

    if (erroAtualizarConversa) {
      console.error("Erro ao atualizar conversa:", erroAtualizarConversa);
    }

    // monta contexto para a ia
    let contextoDeParceiros = "Nenhum parceiro específico encontrado.";
    if (Array.isArray(parceiros) && parceiros.length > 0) {
      contextoDeParceiros =
        "Parceiros Encontrados:\n" +
        parceiros
          .map((p) => {
            const beneficio = p.beneficio_bepit ? String(p.beneficio_bepit) : "—";
            const endereco = p.endereco ? String(p.endereco) : "—";
            return `- Nome: ${p.nome}\n  - Descrição: ${p.descricao}\n  - Endereço: ${endereco}\n  - Benefício Exclusivo BEPIT: ${beneficio}`;
          })
          .join("\n\n");
    }

    const promptFinal = `
[OBJETIVO]
você é o bepit, concierge especialista e sincero da ${regiao.nome_regiao}. priorize sempre os parceiros encontrados.

[parceiro em foco]
${parceiroEmFoco ? `nome: ${parceiroEmFoco.nome}` : "nenhum parceiro em foco no momento."}

[dados de parceiros encontrados]
${contextoDeParceiros}

[regras]
1) se existirem parceiros, recomende diretamente como se fosse sua sugestão pessoal.
2) se não existirem parceiros, use conhecimento geral da região.
3) respostas curtas e diretas (2 a 4 frases).
4) se a pergunta for curta do tipo “horário?”, “endereço?”, “contato?”, “fotos?”, “preço?”, assuma que é sobre o parceiro em foco.
5) fale apenas sobre turismo e serviços na ${regiao.nome_regiao}. para outros assuntos, recuse gentilmente.

[pergunta do usuário]
"${textoDoUsuario}"
`.trim();

    const resultadoDaIa = await modeloGenerativo.generateContent(promptFinal);
    const textoDaIa = resultadoDaIa.response.text();

    // fotos para o cliente
    const fotosParaCliente = parceiroEmFoco && Array.isArray(parceiroEmFoco.link_fotos)
      ? parceiroEmFoco.link_fotos
      : (Array.isArray(parceiros) ? parceiros.flatMap((p) => Array.isArray(p.link_fotos) ? p.link_fotos : []) : []);

    // salva interação
    const { data: novaInteracao, error: erroSalvarInteracao } = await supabase
      .from("interacoes")
      .insert({
        regiao_id: regiao.id,
        conversation_id: conversationId,
        pergunta_usuario: textoDoUsuario,
        resposta_ia: textoDaIa,
        parceiros_sugeridos: Array.isArray(parceiros) ? parceiros : []
      })
      .select("id")
      .single();

    if (erroSalvarInteracao) {
      console.error("Erro ao salvar interação:", erroSalvarInteracao);
    }

    // devolve ao cliente
    return response.status(200).json({
      reply: textoDaIa,
      interactionId: novaInteracao?.id || null,
      photoLinks: fotosParaCliente,
      conversationId: conversationId
    });

  } catch (error) {
    console.error("[/api/chat] Erro interno:", error);
    return response.status(500).json({ error: "Ocorreu um erro interno no servidor do BEPIT." });
  }
});

// -----------------------------------------------------------------------------------
// ROTA DE FEEDBACK
// -----------------------------------------------------------------------------------
application.post("/api/feedback", async (request, response) => {
  try {
    const { interactionId, feedback } = request.body;

    if (!interactionId || typeof interactionId !== "string") {
      return response.status(400).json({ error: "O campo 'interactionId' é obrigatório e deve ser uma string (uuid)." });
    }
    if (!feedback || typeof feedback !== "string" || feedback.trim().length === 0) {
      return response.status(400).json({ error: "O campo 'feedback' é obrigatório e deve ser uma string não vazia." });
    }

    const { error } = await supabase
      .from("interacoes")
      .update({ feedback_usuario: feedback })
      .eq("id", interactionId);

    if (error) {
      console.error("Erro ao registrar feedback:", error);
      return response.status(500).json({ error: "Erro ao registrar feedback." });
    }

    return response.status(200).json({ success: true, message: "Feedback registrado com sucesso." });
  } catch (error) {
    console.error("[/api/feedback] Erro ao registrar feedback:", error);
    return response.status(500).json({ error: "Erro ao registrar feedback." });
  }
});

// -----------------------------------------------------------------------------------
// SUBIR O SERVIDOR
// -----------------------------------------------------------------------------------
application.listen(servidorPorta, () => {
  console.log(`✅ 🤖 Servidor do BEPIT Nexus (v2.0) rodando em http://localhost:${servidorPorta}`);
});
