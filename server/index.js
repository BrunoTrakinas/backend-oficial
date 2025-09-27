// F:\uber-chat-mvp\backend-oficial\server\index.js
// ============================================================================
// BEPIT Nexus - Servidor (Express)
// - Carrega .env antes de qualquer import que use process.env
// - Suporta conversa com contexto (conversationId) e follow-ups diretos
// - Organização por REGIÃO → CIDADES → PARCEIROS/DICAS
// - Métricas básicas e proteção contra erros (guard rails)
// - Entende follow-ups por número ("3"), por nome/categoria ("churrascaria")
// - Fallback seguro se Gemini estiver desligado ou indisponível
// ============================================================================

import "dotenv/config";

import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabaseClient.js";

// ============================== CONFIG BÁSICA ===============================
const application = express();
const servidorPorta = process.env.PORT || 3002;

// --------------------------------- CORS ------------------------------------
// CORS flexível para localhost e Netlify (produção + previews)
const allowOrigin = (origin) => {
  if (!origin) return true; // permite Postman/cURL sem Origin

  try {
    const url = new URL(origin);
    const host = url.host; // ex.: bepitnexus.netlify.app ou abc--bepitnexus.netlify.app

    // localhost (qualquer porta)
    if (url.hostname === "localhost") return true;

    // domínio principal no Netlify
    if (host === "bepitnexus.netlify.app") return true;

    // qualquer preview/branch do Netlify (*.netlify.app)
    if (host.endsWith(".netlify.app")) return true;

    return false;
  } catch {
    return false;
  }
};

application.use(
  cors({
    origin: (origin, cb) => (allowOrigin(origin) ? cb(null, true) : cb(new Error("CORS bloqueado para essa origem."))),
    credentials: true
  })
);

// OPTIONS preflight
application.options("*", cors());

// Body parser JSON
application.use(express.json());

// ------------------------------- GEMINI -------------------------------------
const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== DEBUG/SAFE MODE =====
// Ative DISABLE_GEMINI=1 no .env para pular chamadas à IA (útil p/ testes)
const DISABLE_GEMINI = process.env.DISABLE_GEMINI === "1";

// ------------------------------ HELPERS -------------------------------------
function logStep(label, extra = null) {
  const time = new Date().toISOString();
  if (extra !== null && extra !== undefined) {
    console.log(`[${time}] [DEBUG] ${label}`, extra);
  } else {
    console.log(`[${time}] [DEBUG] ${label}`);
  }
}

// Utilitário opcional (não obrigatório)
function slugify(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// ============================================================================
// MIDDLEWARE: protege rotas de admin com chave no header X-Admin-Key
// ============================================================================
function exigirAdminKey(req, res, next) {
  const header = req.headers["x-admin-key"];
  if (!header || header !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "admin key inválida ou ausente" });
  }
  next();
}

// ============================================================================
// SUPORTE A CONVERSA EM MEMÓRIA (fallback se Supabase falhar em algum ponto)
// - NÃO substitui o banco; só garante continuidade se algum insert/select cair
// ============================================================================
const memoriaConversas = new Map(); // conversationId -> { parceiro_em_foco, parceiros_sugeridos }

function carregarConversaMem(conversationId) {
  return memoriaConversas.get(conversationId) || { parceiro_em_foco: null, parceiros_sugeridos: [] };
}

function salvarConversaMem(conversationId, payload) {
  const atual = carregarConversaMem(conversationId);
  memoriaConversas.set(conversationId, {
    parceiro_em_foco: payload.parceiro_em_foco ?? atual.parceiro_em_foco,
    parceiros_sugeridos: Array.isArray(payload.parceiros_sugeridos)
      ? payload.parceiros_sugeridos
      : atual.parceiros_sugeridos
  });
}

// ============================================================================
// DETECÇÃO DE INTENÇÕES E SELEÇÃO DE ITENS
// ============================================================================

function detectarIntencaoDeFollowUp(textoDoUsuario) {
  const t = String(textoDoUsuario || "").toLowerCase();

  const mapa = [
    {
      intencao: "horario",
      padroes: ["horário", "horario", "hora", "abre", "fecha", "funciona", "funcionamento", "que horas"]
    },
    {
      intencao: "endereco",
      padroes: ["onde fica", "endereço", "endereco", "localização", "localizacao", "como chegar", "fica onde"]
    },
    {
      intencao: "contato",
      padroes: ["contato", "telefone", "whatsapp", "whats", "ligar"]
    },
    {
      intencao: "fotos",
      padroes: ["foto", "fotos", "imagem", "imagens", "galeria"]
    },
    {
      intencao: "preco",
      padroes: ["preço", "preco", "faixa de preço", "faixa de preco", "caro", "barato", "valor", "quanto custa"]
    }
  ];

  for (const item of mapa) {
    for (const termo of item.padroes) {
      if (t.includes(termo)) return item.intencao;
    }
  }
  return "nenhuma";
}

// Palavras para números → índice (1→0, 2→1, ...)
const mapaOrdinal = new Map([
  ["1", 0], ["um", 0], ["uma", 0], ["primeiro", 0], ["1º", 0], ["1o", 0], ["opcao 1", 0], ["opção 1", 0],
  ["2", 1], ["dois", 1], ["duas", 1], ["segundo", 1], ["2º", 1], ["2o", 1], ["opcao 2", 1], ["opção 2", 1],
  ["3", 2], ["tres", 2], ["três", 2], ["terceiro", 2], ["3º", 2], ["3o", 2], ["opcao 3", 2], ["opção 3", 2],
  ["4", 3], ["quatro", 3], ["quarto", 3], ["4º", 3], ["4o", 3],
  ["5", 4], ["cinco", 4], ["quinto", 4], ["5º", 4], ["5o", 4]
]);

function extrairIndiceEscolhido(texto) {
  const t = String(texto || "").toLowerCase().trim();

  // 1) Detecta "opção 3", "numero 2", "nº 4" etc.
  const regexNumExplicito = /(op[cç][aã]o|opcao|opção|n[uú]mero|numero|n[ºo]|#)\s*(\d{1,2})/i;
  const m1 = t.match(regexNumExplicito);
  if (m1 && m1[2]) {
    const idx = parseInt(m1[2], 10) - 1;
    if (idx >= 0) return idx;
  }

  // 2) Número solto "3"
  const regexNumSolto = /(^|\s)(\d{1,2})(\s|$)/;
  const m2 = t.match(regexNumSolto);
  if (m2 && m2[2]) {
    const idx = parseInt(m2[2], 10) - 1;
    if (idx >= 0) return idx;
  }

  // 3) Palavras ("primeiro", "terceiro", "três", "tres")
  for (const [chave, idx] of mapaOrdinal.entries()) {
    if (t.includes(chave)) return idx;
  }

  return null;
}

function normalizar(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tentarAcharParceiroPorNomeOuCategoria(texto, lista) {
  const t = normalizar(texto);
  // termos chave comuns
  const sinonimos = [
    "churrascaria", "pizzaria", "praia", "restaurante", "bar", "balada", "trilha", "mergulho"
  ];

  // 1) Tenta por nome exato (contém)
  let melhor = null;
  for (const p of lista || []) {
    const nome = normalizar(p.nome);
    if (t.includes(nome) || nome.includes(t)) {
      melhor = p;
      break;
    }
  }
  if (melhor) return melhor;

  // 2) Tenta por categoria aproximada
  for (const p of lista || []) {
    const cat = normalizar(p.categoria || "");
    for (const s of sinonimos) {
      if (t.includes(s) && (cat.includes(s) || s.includes(cat))) {
        return p;
      }
    }
    // fallback: se o texto contém categoria bruta
    if (cat && (t.includes(cat) || cat.includes(t))) return p;
  }

  return null;
}

// Monta mensagem-resumo do parceiro focado
function resumoDoParceiro(parceiro) {
  if (!parceiro) return "Não encontrei esse parceiro.";
  const nom = parceiro.nome || "—";
  const cat = parceiro.categoria || "categoria não informada";
  const benef = parceiro.beneficio_bepit ? ` — Benefício BEPIT: ${parceiro.beneficio_bepit}` : "";
  return `Sobre **${nom}** (${cat})${benef}. Posso te passar **endereço**, **horário**, **contato/WhatsApp**, **faixa de preço** ou mostrar **fotos**. O que você prefere?`;
}

// ============================================================================
// ROTA DE SAÚDE
// ============================================================================
application.get("/health", (request, response) => {
  response.status(200).json({
    ok: true,
    message: "Servidor BEPIT Nexus online",
    port: String(servidorPorta)
  });
});

// ============================================================================
// ROTA DE LISTA DE PARCEIROS (teste simples / diagnóstico)
// ============================================================================
application.get("/api/parceiros", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("parceiros")
      .select("id, nome, categoria")
      .eq("ativo", true)
      .limit(20);

    if (error) throw error;
    res.json({ parceiros: data });
  } catch (err) {
    console.error("Erro Supabase:", err);
    res.status(500).json({ error: "Erro ao buscar parceiros" });
  }
});

// ============================================================================
// ANALISAR ENTRADA COM IA (correções + perfil + sugestão de cidade)
// ============================================================================
async function analisarEntradaUsuario(texto, cidades) {
  // Fallback simples quando a IA estiver desligada
  if (DISABLE_GEMINI) {
    const lower = String(texto || "").toLowerCase();
    const cidadeSlug =
      (cidades || []).find(
        (c) =>
          lower.includes(String(c.nome).toLowerCase()) ||
          lower.includes(String(c.slug).toLowerCase())
      )?.slug || null;

    return {
      corrigido: texto,
      companhia: null,
      vibe: null,
      orcamento: null,
      cidadeSlugSugerida: cidadeSlug,
      palavrasChave: []
    };
  }

  try {
    const modelo = geminiClient.getGenerativeModel({ model: "gemini-1.5-flash" });
    const listaCidades = (cidades || []).map((c) => ({ nome: c.nome, slug: c.slug }));

    const prompt = `
Você é um analisador de linguagem natural para turismo no Brasil.
Tarefas:
1) Corrija apenas erros claros de digitação mantendo a intenção original.
2) Inferir (se possível) o perfil do usuário:
   - companhia: "casal" | "familia" | "amigos" | "sozinho" | null
   - vibe: "romantico" | "tranquilo" | "agitado" | "aventura" | null
   - orcamento: "baixo" | "medio" | "alto" | null
3) Sugerir cidade (se houver) com base nestas opções (use o slug exato ou null):
   ${JSON.stringify(listaCidades)}
4) Gerar até 5 palavras_chave (minúsculas, simples).

Responda APENAS JSON, sem comentários, nesse formato:
{
  "corrigido": "...",
  "companhia": "...",
  "vibe": "...",
  "orcamento": "...",
  "cidadeSlugSugerida": "...",
  "palavrasChave": ["...","..."]
}

Frase original: "${texto}"
`.trim();

    const resp = await modelo.generateContent(prompt);
    let out = (await resp.response.text()).trim();

    // Remove cercas de código se vierem
    out = out.replace(/```json|```/g, "");
    const parsed = JSON.parse(out);

    return {
      corrigido: parsed.corrigido ?? texto,
      companhia: parsed.companhia ?? null,
      vibe: parsed.vibe ?? null,
      orcamento: parsed.orcamento ?? null,
      cidadeSlugSugerida: parsed.cidadeSlugSugerida ?? null,
      palavrasChave: Array.isArray(parsed.palavrasChave) ? parsed.palavrasChave : []
    };
  } catch (e) {
    console.error("[IA Gemini] analisarEntradaUsuario falhou:", e);
    return {
      corrigido: texto,
      companhia: null,
      vibe: null,
      orcamento: null,
      cidadeSlugSugerida: null,
      palavrasChave: []
    };
  }
}

// ============================================================================
// ROTA PRINCIPAL DO CHAT
// ============================================================================
application.post("/api/chat/:slugDaRegiao", async (request, response) => {
  console.log("\n--- NOVA INTERAÇÃO ---");
  try {
    const { slugDaRegiao } = request.params;
    let { message: textoDoUsuario, conversationId } = request.body;

    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return response
        .status(400)
        .json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }

    // 1) Carregar a REGIÃO
    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", slugDaRegiao)
      .single();

    if (erroRegiao || !regiao) {
      console.error("[SUPABASE] Erro ao carregar região:", erroRegiao);
      return response
        .status(404)
        .json({ error: `Região com apelido (slug) '${slugDaRegiao}' não encontrada.` });
    }

    // 2) Carregar as CIDADES dessa região
    const { data: cidades, error: erroCidades } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", regiao.id);

    if (erroCidades) {
      console.error("[SUPABASE] Erro ao carregar cidades:", erroCidades);
      return response.status(500).json({ error: "Erro ao carregar cidades." });
    }

    // 3) Detectar cidade pelo texto (regras simples + IA)
    const textoMinusculo = textoDoUsuario.toLowerCase();
    let cidadeDetectada = null;
    for (const c of cidades || []) {
      const nomeLower = String(c.nome).toLowerCase();
      const slugLower = String(c.slug).toLowerCase();
      if (textoMinusculo.includes(nomeLower) || textoMinusculo.includes(slugLower)) {
        cidadeDetectada = c;
        break;
      }
    }

    const analise = await analisarEntradaUsuario(textoDoUsuario, cidades);
    if (!cidadeDetectada && analise.cidadeSlugSugerida) {
      const cand = (cidades || []).find((c) => c.slug === analise.cidadeSlugSugerida);
      if (cand) cidadeDetectada = cand;
    }

    const perfilUsuario = {
      companhia: analise.companhia, // casal | familia | amigos | sozinho | null
      vibe: analise.vibe,           // romantico | tranquilo | agitado | aventura | null
      orcamento: analise.orcamento  // baixo | medio | alto | null
    };

    // 4) Criar conversationId se não veio do front
    if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
      conversationId = randomUUID();
      try {
        const { error: erroCriarConversa } = await supabase.from("conversas").insert({
          id: conversationId,
          regiao_id: regiao.id,
          parceiro_em_foco: null,
          parceiros_sugeridos: [],
          ultima_pergunta_usuario: null,
          ultima_resposta_ia: null
        });
        if (erroCriarConversa) throw erroCriarConversa;
      } catch (e) {
        console.error("[SUPABASE] Erro ao criar conversa (fallback memória):", e);
        salvarConversaMem(conversationId, { parceiro_em_foco: null, parceiros_sugeridos: [] });
      }
    }

    // 5) Carregar conversa atual (para follow-ups)
    let conversaAtual = null;
    try {
      const { data: c, error: erroConversa } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, parceiros_sugeridos")
        .eq("id", conversationId)
        .single();
      if (erroConversa) throw erroConversa;
      conversaAtual = c;
    } catch (e) {
      console.warn("[SUPABASE] Falha ao carregar conversa, usando memória:", e);
      conversaAtual = carregarConversaMem(conversationId);
    }

    // 6) Registrar busca e evento de analytics (não derrubar rota se falhar)
    try {
      await supabase.from("buscas_texto").insert({
        regiao_id: regiao.id,
        cidade_id: cidadeDetectada?.id || null,
        texto: textoDoUsuario
      });
      await supabase.from("eventos_analytics").insert({
        regiao_id: regiao.id,
        cidade_id: cidadeDetectada?.id || null,
        conversation_id: conversationId,
        tipo_evento: "search",
        payload: { q: textoDoUsuario }
      });
    } catch (e) {
      console.error("[SUPABASE] Falha ao registrar métricas de busca (segue):", e);
    }

    // 7) Se já temos parceiros_sugeridos de antes, tente entender seleção por número ou nome
    const intencao = detectarIntencaoDeFollowUp(textoDoUsuario);

    // Se a pessoa disse "3", "primeiro", "a churrascaria", etc.
    if (!conversaAtual.parceiro_em_foco && Array.isArray(conversaAtual.parceiros_sugeridos) && conversaAtual.parceiros_sugeridos.length > 0) {
      let escolhido = null;

      const idx = extrairIndiceEscolhido(textoDoUsuario);
      if (idx !== null && idx >= 0 && idx < conversaAtual.parceiros_sugeridos.length) {
        escolhido = conversaAtual.parceiros_sugeridos[idx];
      }

      if (!escolhido) {
        escolhido = tentarAcharParceiroPorNomeOuCategoria(textoDoUsuario, conversaAtual.parceiros_sugeridos);
      }

      if (escolhido) {
        // Atualiza conversa com foco
        try {
          const { error: erroUpdConv } = await supabase
            .from("conversas")
            .update({
              parceiro_em_foco: escolhido
            })
            .eq("id", conversationId);
          if (erroUpdConv) throw erroUpdConv;
        } catch (e) {
          console.warn("[SUPABASE] Não consegui salvar foco, guardando em memória:", e);
          salvarConversaMem(conversationId, { parceiro_em_foco: escolhido });
        }

        // Retorna um resumo direto do parceiro e pergunta o próximo detalhe
        return response.status(200).json({
          reply: resumoDoParceiro(escolhido),
          interactionId: null,
          photoLinks: Array.isArray(escolhido.fotos_parceiros) ? escolhido.fotos_parceiros : [],
          conversationId
        });
      }
    }

    // Follow-ups diretos se houver parceiro em foco (endereço, horário, contato, fotos, preço)
    if (conversaAtual.parceiro_em_foco && intencao !== "nenhuma") {
      const parceiroAtual = conversaAtual.parceiro_em_foco;

      if (intencao === "horario") {
        const horario = parceiroAtual.horario_funcionamento
          ? String(parceiroAtual.horario_funcionamento)
          : "O parceiro não informou horário de funcionamento.";
        const respostaDireta = `Horário de funcionamento de ${parceiroAtual.nome}: ${horario}`;
        await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaDireta,
            parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
          })
          .catch(() => {});
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "endereco") {
        const endereco = parceiroAtual.endereco ? String(parceiroAtual.endereco) : "Endereço não informado.";
        const respostaDireta = `Endereço de ${parceiroAtual.nome}: ${endereco}`;
        await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaDireta,
            parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
          })
          .catch(() => {});
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "contato") {
        const contato = parceiroAtual.contato ? String(parceiroAtual.contato) : "Contato não informado.";
        const respostaDireta = `Contato de ${parceiroAtual.nome}: ${contato}`;
        await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaDireta,
            parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
          })
          .catch(() => {});
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "fotos") {
        const possuiFotos = Array.isArray(parceiroAtual.fotos_parceiros) && parceiroAtual.fotos_parceiros.length > 0;
        const respostaDireta = possuiFotos
          ? `Aqui estão algumas fotos de ${parceiroAtual.nome}.`
          : `Não encontrei fotos de ${parceiroAtual.nome}.`;
        await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaDireta,
            parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
          })
          .catch(() => {});
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: possuiFotos ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "preco") {
        const faixaDePreco = parceiroAtual.faixa_preco
          ? String(parceiroAtual.faixa_preco)
          : "Faixa de preço não informada.";
        const respostaDireta = `Faixa de preço de ${parceiroAtual.nome}: ${faixaDePreco}`;
        await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaDireta,
            parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
          })
          .catch(() => {});
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }
    }

    // 8) Buscar itens (parceiros/dicas) conforme perfil/termos
    logStep("INÍCIO - extração de palavras-chave");
    let termos = [];

    const reforcosPorPerfil = [];
    if (analise?.palavrasChave?.length) {
      for (const k of analise.palavrasChave) reforcosPorPerfil.push(String(k).toLowerCase());
    }
    if (perfilUsuario.companhia === "casal" || perfilUsuario.vibe === "romantico") {
      reforcosPorPerfil.push("romantico", "jantar", "vista", "pôr do sol", "vinho");
    }
    if (perfilUsuario.vibe === "tranquilo") {
      reforcosPorPerfil.push("tranquilo", "barco privativo", "praia calma", "silencioso");
    }
    if (perfilUsuario.vibe === "agitado") {
      reforcosPorPerfil.push("balada", "música ao vivo", "bar");
    }
    if (perfilUsuario.vibe === "aventura") {
      reforcosPorPerfil.push("trilha", "mergulho", "passeio de barco");
    }
    if (perfilUsuario.orcamento === "baixo") {
      reforcosPorPerfil.push("bom e barato", "popular");
    }
    if (perfilUsuario.orcamento === "alto") {
      reforcosPorPerfil.push("premium", "sofisticado", "menu degustação");
    }
    termos = Array.from(new Set([...reforcosPorPerfil]));

    if (!DISABLE_GEMINI) {
      try {
        const modeloKW = geminiClient.getGenerativeModel({ model: "gemini-1.5-flash" });
        const promptKW = `
extraia até 3 palavras-chave de turismo da frase abaixo.
regras:
- responda apenas com as palavras separadas por vírgula.
- tudo em minúsculas, sem explicações.
- se não achar nada, responda "geral".
frase: "${textoDoUsuario}"
`.trim();

        const resultadoKW = await modeloKW.generateContent(promptKW);
        const textoKW = (await resultadoKW.response.text()).trim();
        const linhaKW = (textoKW.split("\n")[0] || "").replace(/["'“”‘’]/g, "");
        const baseKW = linhaKW.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

        const set = new Set(termos);
        for (const p of baseKW) {
          if (p && p.length >= 3) set.add(p);
          if (p && p.endsWith("s") && p.slice(0, -1).length >= 3) set.add(p.slice(0, -1));
          if (p && !p.endsWith("s") && (p + "s").length >= 3) set.add(p + "s");
        }
        termos = Array.from(set);
        logStep("Palavras-chave extraídas", termos);
      } catch (e) {
        console.error("[KW Gemini] Falha ao extrair palavras-chave (segue sem filtro):", e);
      }
    } else {
      logStep("DISABLE_GEMINI=1 → pulando extração de palavras-chave");
    }

    // 9) Buscar parceiros/dicas (Supabase)
    const cidadeIds = cidadeDetectada ? [cidadeDetectada.id] : (cidades || []).map((c) => c.id);

    // Base query (ilike por nome/categoria)
    let consulta = supabase
      .from("parceiros")
      .select(
        "id, tipo, nome, categoria, descricao, beneficio_bepit, endereco, contato, tags, horario_funcionamento, faixa_preco, fotos_parceiros, cidade_id"
      )
      .eq("ativo", true)
      .in("cidade_id", cidadeIds);

    if (termos.length > 0) {
      const partesOR = [];
      for (const t of termos) {
        const wildcard = `*${t}*`; // PostgREST usa * como curinga no ilike
        partesOR.push(`nome.ilike.${wildcard}`);
        partesOR.push(`categoria.ilike.${wildcard}`);
      }
      consulta = consulta.or(partesOR.join(","));
    }

    let { data: itens, error: erroItens } = await consulta;
    if (erroItens) {
      console.error("[SUPABASE] Erro ao consultar parceiros/dicas (ilike):", erroItens);
      return response.status(500).json({ error: "Falha ao consultar parceiros/dicas." });
    }
    itens = Array.isArray(itens) ? itens : [];

    // Consulta extra por TAGS (jsonb) para cada termo e junta resultados (OR por tags)
    // Agora evita duplicados comparando nome + categoria + endereço
    if (termos.length > 0) {
      for (const t of termos) {
        const { data: itensTag, error: erroTag } = await supabase
          .from("parceiros")
          .select(
            "id, tipo, nome, categoria, descricao, beneficio_bepit, endereco, contato, tags, horario_funcionamento, faixa_preco, fotos_parceiros, cidade_id"
          )
          .eq("ativo", true)
          .in("cidade_id", cidadeIds)
          .contains("tags", [t]); // jsonb array contém t

        if (!erroTag && Array.isArray(itensTag)) {
          for (const p of itensTag) {
            // Regra: não adicionar se já existe mesmo nome+categoria+endereco
            const jaExiste = itens.some(
              (x) =>
                x.nome?.toLowerCase() === p.nome?.toLowerCase() &&
                (x.categoria || "").toLowerCase() === (p.categoria || "").toLowerCase() &&
                (x.endereco || "").toLowerCase() === (p.endereco || "").toLowerCase()
            );
            if (!jaExiste) {
              itens.push(p);
            }
          }
        }
      }
    }

    // 10) Escolher parceiro em foco e atualizar conversa (sem quebrar rota se falhar)
    const parceiroEmFoco = itens.length > 0 ? itens[0] : null;
    try {
      const { error: erroUpdConv } = await supabase
        .from("conversas")
        .update({
          parceiro_em_foco: parceiroEmFoco,
          parceiros_sugeridos: itens
        })
        .eq("id", conversationId);
      if (erroUpdConv) throw erroUpdConv;
    } catch (e) {
      console.warn("[SUPABASE] Erro ao atualizar conversa (memória):", e);
      salvarConversaMem(conversationId, { parceiro_em_foco: parceiroEmFoco, parceiros_sugeridos: itens });
    }

    // 11) Montar contexto dos itens
    const contextoDeItens =
      itens.length > 0
        ? itens
            .slice(0, 10)
            .map((p) => {
              const etiqueta = p.tipo === "DICA" ? "[DICA]" : "[PARCEIRO]";
              const endereco = p.endereco ? String(p.endereco) : "—";
              const beneficio = p.beneficio_bepit ? ` | Benefício BEPIT: ${p.beneficio_bepit}` : "";
              return `${etiqueta} ${p.nome} — ${p.categoria || "—"} — ${endereco}${beneficio}`;
            })
            .join("\n")
        : "Nenhum parceiro ou dica encontrado.";

    const listaCidades = (cidades || []).map((c) => c.nome).join(", ");

    // 12) Resposta final (Gemini com fallback)
    function montarRespostaFallback({ regiao, cidadeDetectada, itens, listaCidades }) {
      if (itens && itens.length > 0) {
        const top = itens
          .slice(0, 3)
          .map((p, i) => {
            const benef = p.beneficio_bepit ? ` — Benefício BEPIT: ${p.beneficio_bepit}` : "";
            return `${i + 1}. ${p.nome} (${p.categoria || "categoria não informada"})${benef}`;
          })
          .join(" ");
        const foco = cidadeDetectada ? ` em ${cidadeDetectada.nome}` : "";
        return `Aqui vão algumas opções${foco}: ${top}. Quer que eu foque em alguma delas ou filtre por cidade (${listaCidades})?`;
      }
      const foco = cidadeDetectada ? ` em ${cidadeDetectada.nome}` : "";
      return `Ainda não encontrei itens${foco}. Posso procurar por categoria (ex.: restaurante, passeio) ou filtrar por cidade (${listaCidades}).`;
    }

    logStep("INÍCIO - geração de resposta final");
    let textoIA = "";

    if (!DISABLE_GEMINI) {
      try {
        const modeloIA = geminiClient.getGenerativeModel({ model: "gemini-1.5-flash" });
        const promptFinal = `
Você é o BEPIT, concierge especialista e sincero da região ${regiao.nome}.

Regras:
1) Priorize itens encontrados (parceiros e dicas).
2) Use o perfil do usuário (abaixo) para refinar a recomendação (ex.: casal + romântico → jantar romântico, barco tranquilo).
3) Se houver cidade detectada, foque nela; senão, diga que posso filtrar por: ${listaCidades}.
4) Respostas curtas e diretas (2 a 4 frases). Cite benefícios BEPIT quando existirem.
5) Fale apenas sobre turismo e serviços desta região.

[Perfil do usuário (inferido)]
companhia: ${perfilUsuario.companhia || "desconhecida"}
vibe: ${perfilUsuario.vibe || "desconhecida"}
orcamento: ${perfilUsuario.orcamento || "desconhecido"}

[Cidade detectada]
${cidadeDetectada ? cidadeDetectada.nome : "nenhuma"}

[Itens disponíveis (até 10)]
${contextoDeItens}

[Pergunta do usuário]
"${textoDoUsuario}"
`.trim();

        const respIA = await modeloIA.generateContent(promptFinal);
        textoIA = respIA.response.text();
        logStep("Resposta IA gerada");
      } catch (e) {
        console.error("[IA Gemini] Falha ao gerar resposta (usando fallback):", e);
        textoIA = montarRespostaFallback({ regiao, cidadeDetectada, itens, listaCidades });
      }
    } else {
      logStep("DISABLE_GEMINI=1 → usando fallback de resposta");
      textoIA = montarRespostaFallback({ regiao, cidadeDetectada, itens, listaCidades });
    }

    // 13) Métrica de visualização do parceiro em foco (não derrubar se falhar)
    try {
      if (parceiroEmFoco?.id) {
        const { data: registroView, error: errSelView } = await supabase
          .from("parceiro_views")
          .select("*")
          .eq("parceiro_id", parceiroEmFoco.id)
          .maybeSingle();

        if (errSelView) throw errSelView;

        if (registroView) {
          const { error: errUpdView } = await supabase
            .from("parceiro_views")
            .update({
              views_total: (registroView.views_total || 0) + 1,
              last_view_at: new Date().toISOString()
            })
            .eq("parceiro_id", parceiroEmFoco.id);
          if (errUpdView) throw errUpdView;
        } else {
          const { error: errInsView } = await supabase
            .from("parceiro_views")
            .insert({
              parceiro_id: parceiroEmFoco.id,
              views_total: 1,
              last_view_at: new Date().toISOString()
            });
          if (errInsView) throw errInsView;
        }

        await supabase.from("eventos_analytics").insert({
          regiao_id: regiao.id,
          cidade_id: parceiroEmFoco.cidade_id,
          parceiro_id: parceiroEmFoco.id,
          conversation_id: conversationId,
          tipo_evento: "partner_view",
          payload: { nome: parceiroEmFoco.nome }
        });
      }
    } catch (e) {
      console.error("[SUPABASE] Falha em parceiro_views/eventos_analytics (segue):", e);
    }

    // 14) Registrar interação completa (sem derrubar se falhar)
    let interactionId = null;
    try {
      const { data: novaInteracao, error: erroInter } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: textoIA,
          parceiros_sugeridos: itens
        })
        .select("id")
        .single();

      if (erroInter) throw erroInter;
      interactionId = novaInteracao?.id || null;
    } catch (e) {
      console.error("[SUPABASE] Falha ao salvar interação (segue):", e);
    }

    // 15) Fotos para o front
    const fotosParaCliente =
      parceiroEmFoco && Array.isArray(parceiroEmFoco.fotos_parceiros)
        ? parceiroEmFoco.fotos_parceiros
        : itens.flatMap((p) => (Array.isArray(p.fotos_parceiros) ? p.fotos_parceiros : []));

    return response.status(200).json({
      reply: textoIA,
      interactionId: interactionId,
      photoLinks: fotosParaCliente,
      conversationId
    });
  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return response.status(500).json({ error: "Erro interno no servidor do BEPIT." });
  }
});

// ============================================================================
// ROTA DE FEEDBACK
// ============================================================================
application.post("/api/feedback", async (request, response) => {
  try {
    const { interactionId, feedback } = request.body;

    if (!interactionId || typeof interactionId !== "string") {
      return response.status(400).json({
        error: "O campo 'interactionId' é obrigatório e deve ser uma string (uuid)."
      });
    }
    if (!feedback || typeof feedback !== "string" || feedback.trim().length === 0) {
      return response.status(400).json({
        error: "O campo 'feedback' é obrigatório e deve ser uma string não vazia."
      });
    }

    const { error: erroUpd } = await supabase
      .from("interacoes")
      .update({ feedback_usuario: feedback })
      .eq("id", interactionId);

    if (erroUpd) {
      console.error("[/api/feedback] Erro ao atualizar interação:", erroUpd);
      return response.status(500).json({ error: "Erro ao registrar feedback." });
    }

    try {
      await supabase.from("eventos_analytics").insert({
        tipo_evento: "feedback",
        payload: { interactionId, feedback }
      });
    } catch (e) {
      console.error("[/api/feedback] Falha ao gravar evento de analytics (segue):", e);
    }

    return response.status(200).json({ success: true, message: "Feedback registrado com sucesso." });
  } catch (erro) {
    console.error("[/api/feedback] Erro:", erro);
    return response.status(500).json({ error: "Erro ao registrar feedback." });
  }
});

// ============================================================================
// === LOGIN DO ADMIN (MVP)
// ============================================================================
application.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const userOk = username && username === process.env.ADMIN_USER;
    const passOk = password && password === process.env.ADMIN_PASS;

    if (!userOk || !passOk) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    // MVP: devolvemos a adminKey para o front usar no header X-Admin-Key
    return res.json({
      ok: true,
      adminKey: process.env.ADMIN_API_KEY
    });
  } catch (e) {
    console.error("[/api/admin/login] erro:", e);
    return res.status(500).json({ error: "erro interno" });
  }
});

// ============================================================================
// ADMIN BÁSICO (MVP): criar/listar/editar parceiros via backend
// ============================================================================
application.post("/api/admin/parceiros", exigirAdminKey, async (request, response) => {
  try {
    const body = request.body;
    const { regiaoSlug, cidadeSlug, ...restante } = body;

    const { data: regiao, error: eReg } = await supabase
      .from("regioes")
      .select("id")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !regiao) return response.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase
      .from("cidades")
      .select("id")
      .eq("regiao_id", regiao.id)
      .eq("slug", cidadeSlug)
      .single();
    if (eCid || !cidade) return response.status(400).json({ error: "cidadeSlug inválido." });

    const novoRegistro = {
      cidade_id: cidade.id,
      tipo: restante.tipo || "PARCEIRO", // ou "DICA"
      nome: restante.nome,
      descricao: restante.descricao || null,
      categoria: restante.categoria || null,
      beneficio_bepit: restante.beneficio_bepit || null,
      endereco: restante.endereco || null,
      contato: restante.contato || null,
      tags: Array.isArray(restante.tags) ? restante.tags : null,
      horario_funcionamento: restante.horario_funcionamento || null,
      faixa_preco: restante.faixa_preco || null,
      fotos_parceiros: Array.isArray(restante.fotos_parceiros) ? restante.fotos_parceiros : null,
      ativo: restante.ativo !== false
    };

    const { data, error } = await supabase
      .from("parceiros")
      .insert(novoRegistro)
      .select("*")
      .single();

    if (error) {
      console.error("[/api/admin/parceiros] insert erro:", error);
      return response.status(500).json({ error: "Erro ao criar parceiro/dica." });
    }

    return response.status(200).json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/parceiros] Erro:", erro);
    return response.status(500).json({ error: "Erro interno." });
  }
});

application.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", exigirAdminKey, async (request, response) => {
  try {
    const { regiaoSlug, cidadeSlug } = request.params;

    const { data: regiao, error: eReg } = await supabase
      .from("regioes")
      .select("id")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !regiao) return response.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase
      .from("cidades")
      .select("id")
      .eq("regiao_id", regiao.id)
      .eq("slug", cidadeSlug)
      .single();
    if (eCid || !cidade) return response.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase
      .from("parceiros")
      .select("*")
      .eq("cidade_id", cidade.id)
      .order("nome");

    if (error) {
      console.error("[/api/admin/parceiros list] Erro:", error);
      return response.status(500).json({ error: "Erro ao listar parceiros/dicas." });
    }

    return response.status(200).json({ data });
  } catch (erro) {
    console.error("[/api/admin/parceiros list] Erro:", erro);
    return response.status(500).json({ error: "Erro interno." });
  }
});

application.put("/api/admin/parceiros/:id", exigirAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    // Apenas campos permitidos para edição
    const atualizacao = {
      nome: body.nome ?? null,
      categoria: body.categoria ?? null,
      descricao: body.descricao ?? null,
      beneficio_bepit: body.beneficio_bepit ?? null,
      endereco: body.endereco ?? null,
      contato: body.contato ?? null,
      tags: Array.isArray(body.tags) ? body.tags : null,
      horario_funcionamento: body.horario_funcionamento ?? null,
      faixa_preco: body.faixa_preco ?? null,
      fotos_parceiros: Array.isArray(body.fotos_parceiros) ? body.fotos_parceiros : null,
      ativo: body.ativo !== false
    };

    const { data, error } = await supabase
      .from("parceiros")
      .update(atualizacao)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("[/api/admin/parceiros PUT] Erro:", error);
      return res.status(500).json({ error: "Erro ao atualizar parceiro." });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/parceiros PUT] erro:", e);
    return res.status(500).json({ error: "erro interno" });
  }
});

// ============================================================================
// ADMIN: REGIÕES e CIDADES
// ============================================================================
application.post("/api/admin/regioes", exigirAdminKey, async (req, res) => {
  try {
    const { nome, slug, ativo = true } = req.body || {};
    if (!nome || !slug) return res.status(400).json({ error: "nome e slug são obrigatórios" });

    const { data, error } = await supabase
      .from("regioes")
      .insert({ nome, slug, ativo: Boolean(ativo) })
      .select("*")
      .single();

    if (error) {
      console.error("[/api/admin/regioes] insert erro:", error);
      return res.status(500).json({ error: "Erro ao criar região." });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/regioes] erro:", e);
    res.status(500).json({ error: "erro interno" });
  }
});

application.post("/api/admin/cidades", exigirAdminKey, async (req, res) => {
  try {
    const { regiaoSlug, nome, slug, ativo = true } = req.body || {};
    if (!regiaoSlug || !nome || !slug) {
      return res.status(400).json({ error: "regiaoSlug, nome e slug são obrigatórios" });
    }

    const { data: regiao, error: eReg } = await supabase
      .from("regioes")
      .select("id")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data, error } = await supabase
      .from("cidades")
      .insert({ regiao_id: regiao.id, nome, slug, ativo: Boolean(ativo) })
      .select("*")
      .single();

    if (error) {
      console.error("[/api/admin/cidades] insert erro:", error);
      return res.status(500).json({ error: "Erro ao criar cidade." });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/cidades] erro:", e);
    res.status(500).json({ error: "erro interno" });
  }
});

// ------------------------ Iniciar servidor ------------------------
application.listen(servidorPorta, () => {
  console.log(`✅ BEPIT Nexus rodando em http://localhost:${servidorPorta}`);
});
