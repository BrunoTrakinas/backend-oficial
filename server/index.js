// F:\uber-chat-mvp\backend-oficial\server\index.js
// ============================================================================
// BEPIT Nexus - Servidor (Express)
// - IA “solta” com viés para PARCEIROS e DICAs (tabela única: parceiros)
// - Roteiro (1..N dias) com slots manhã/tarde/noite priorizando parceiros
// - Dicas de morador (tipo="DICA") entram automaticamente quando o tema pede
// - Memória de conversa por conversationId (foco + sugeridos) com fallback em RAM
// - Fallback sincero quando não houver parceiro
// - Sem alucinar: nunca inventar — se não souber, assume e orienta
// - Rotas ADMIN completas (parceiros CRUD, regiões, cidades, métricas, logs)
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
const allowOrigin = (origin) => {
  if (!origin) return true; // Postman/cURL
  try {
    const url = new URL(origin);
    const host = url.host;
    if (url.hostname === "localhost") return true;
    if (host === "bepitnexus.netlify.app") return true;
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

// Body parser
application.use(express.json());

// ------------------------------- GEMINI -------------------------------------
const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const DISABLE_GEMINI = process.env.DISABLE_GEMINI === "0";

// ------------------------------ HELPERS -------------------------------------
function logStep(label, extra = null) {
  const time = new Date().toISOString();
  if (extra !== null && extra !== undefined) console.log(`[${time}] [DEBUG] ${label}`, extra);
  else console.log(`[${time}] [DEBUG] ${label}`);
}

function normalizar(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim();
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
// MEMÓRIA DE CONVERSA (fallback se Supabase falhar)
// ============================================================================
const memoriaConversas = new Map(); // conversationId -> { parceiro_em_foco, parceiros_sugeridos }

function carregarConversaMem(conversationId) {
  return memoriaConversas.get(conversationId) || { parceiro_em_foco: null, parceiros_sugeridos: [] };
}

function salvarConversaMem(conversationId, payload) {
  const atual = carregarConversaMem(conversationId);
  memoriaConversas.set(conversationId, {
    parceiro_em_foco: payload.parceiro_em_foco ?? atual.parceiro_em_foco,
    parceiros_sugeridos: Array.isArray(payload.parceiros_sugeridos) ? payload.parceiros_sugeridos : atual.parceiros_sugeridos
  });
}

// ============================================================================
// INTENÇÕES, SELEÇÃO E FUZZY MATCH
// ============================================================================
function detectarIntencao(texto) {
  const t = normalizar(texto);

  // Roteiro
  const padroesRoteiro = [
    "roteiro", "itinerario", "itinerário", "planeja", "planejar", "planejamento",
    "o que fazer", "x dias", "1 dia", "2 dias", "3 dias", "4 dias", "5 dias",
    "fim de semana", "final de semana", "agenda do dia"
  ];
  if (padroesRoteiro.some((p) => t.includes(p))) return "roteiro";

  // Follow-ups de detalhe
  const mapa = [
    { intencao: "horario", padroes: ["horario", "horário", "abre", "fecha", "funciona", "funcionamento", "que horas"] },
    { intencao: "endereco", padroes: ["endereco", "endereço", "onde fica", "localizacao", "localização", "como chegar"] },
    { intencao: "contato", padroes: ["contato", "telefone", "whatsapp", "whats", "ligar"] },
    { intencao: "fotos", padroes: ["foto", "fotos", "imagem", "imagens", "galeria"] },
    { intencao: "preco", padroes: ["preco", "preço", "faixa de preco", "faixa de preço", "caro", "barato", "valor", "quanto custa"] }
  ];
  for (const item of mapa) if (item.padroes.some((p) => t.includes(p))) return item.intencao;

  // “Dicas de morador”
  const dicasGatilhos = [
    "transito", "trânsito", "engarrafamento", "rota alternativa", "desvio",
    "padaria", "cafe da manha", "café da manhã", "cafe", "café",
    "horario bom", "melhor horario", "melhor horário", "estacionamento",
    "seguranca", "segurança", "evitar", "lotado", "lotação"
  ];
  if (dicasGatilhos.some((p) => t.includes(p))) return "dica";

  return "nenhuma";
}

// índice por número/palavra → 0-based
const mapaOrdinal = new Map([
  ["1", 0], ["um", 0], ["uma", 0], ["primeiro", 0], ["1º", 0], ["1o", 0], ["opcao 1", 0], ["opção 1", 0],
  ["2", 1], ["dois", 1], ["duas", 1], ["segundo", 1], ["2º", 1], ["2o", 1], ["opcao 2", 1], ["opção 2", 1],
  ["3", 2], ["tres", 2], ["três", 2], ["terceiro", 2], ["3º", 2], ["3o", 2], ["opcao 3", 2], ["opção 3", 2],
  ["4", 3], ["quatro", 3], ["quarto", 3], ["4º", 3], ["4o", 3],
  ["5", 4], ["cinco", 4], ["quinto", 4], ["5º", 4], ["5o", 4]
]);

function extrairIndiceEscolhido(texto) {
  const t = normalizar(texto);
  const m1 = t.match(/(op[cç][aã]o|opcao|opção|numero|n[uú]mero|n[ºo]|#)\s*(\d{1,2})/i);
  if (m1 && m1[2]) {
    const idx = parseInt(m1[2], 10) - 1;
    if (idx >= 0) return idx;
  }
  const m2 = t.match(/(^|\s)(\d{1,2})(\s|$)/);
  if (m2 && m2[2]) {
    const idx = parseInt(m2[2], 10) - 1;
    if (idx >= 0) return idx;
  }
  for (const [chave, idx] of mapaOrdinal.entries()) if (t.includes(chave)) return idx;
  return null;
}

// Dice coefficient (bigrams) para fuzzy matching simples (não usamos muito aqui)
// Mantido para evoluções futuras
function bigrams(str) {
  const s = normalizar(str);
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}
function diceSimilarity(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  let inter = 0;
  const freq = new Map();
  for (const g of A) freq.set(g, (freq.get(g) || 0) + 1);
  for (const g of B) { const v = freq.get(g) || 0; if (v > 0) { inter += 1; freq.set(g, v - 1); } }
  return (2 * inter) / (A.length + B.length);
}

function resumoDoParceiro(parceiro) {
  if (!parceiro) return "Não encontrei esse parceiro.";
  const nom = parceiro.nome || "—";
  const cat = parceiro.categoria || "categoria não informada";
  const benef = parceiro.beneficio_bepit ? ` — Benefício BEPIT: ${parceiro.beneficio_bepit}` : "";
  const preco = parceiro.faixa_preco ? ` — Faixa de preço: ${parceiro.faixa_preco}` : "";
  return `Sobre **${nom}** (${cat})${benef}${preco}. Quer **endereço**, **horário**, **contato/WhatsApp**, **faixa de preço** ou **fotos**?`;
}

// ============================================================================
// HEALTH
// ============================================================================
application.get("/health", (req, res) => {
  res.status(200).json({ ok: true, message: "Servidor BEPIT Nexus online", port: String(servidorPorta) });
});

// ============================================================================
// ROTA DE LISTA DE PARCEIROS (diagnóstico)
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
// ANALISAR ENTRADA (IA ou fallback)
// ============================================================================
async function analisarEntradaUsuario(texto, cidades) {
  if (DISABLE_GEMINI) {
    const lower = String(texto || "").toLowerCase();
    const cidadeSlug =
      (cidades || []).find(
        (c) => lower.includes(String(c.nome).toLowerCase()) || lower.includes(String(c.slug).toLowerCase())
      )?.slug || null;
    return { corrigido: texto, companhia: null, vibe: null, orcamento: null, cidadeSlugSugerida: cidadeSlug, palavrasChave: [] };
  }

  try {
    const modelo = geminiClient.getGenerativeModel({ model: "gemini-1.5-flash" });
    const listaCidades = (cidades || []).map((c) => ({ nome: c.nome, slug: c.slug }));

    const prompt = `
Você é um analisador de linguagem natural para turismo no Brasil.
Tarefas:
1) Corrija erros simples mantendo a intenção.
2) Inferir (se possível): companhia ("casal"|"familia"|"amigos"|"sozinho"|null), vibe ("romantico"|"tranquilo"|"agitado"|"aventura"|null), orcamento ("baixo"|"medio"|"alto"|null).
3) Sugerir cidade (slug exato) a partir destas: ${JSON.stringify(listaCidades)} (ou null).
4) Palavras_chave (até 5, minúsculas).
Responda somente JSON: {"corrigido":"...","companhia":"...","vibe":"...","orcamento":"...","cidadeSlugSugerida":"...","palavrasChave":["..."]}
Frase: "${texto}"
`.trim();

    const resp = await modelo.generateContent(prompt);
    let out = (await resp.response.text()).trim();
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
    return { corrigido: texto, companhia: null, vibe: null, orcamento: null, cidadeSlugSugerida: null, palavrasChave: [] };
  }
}

// ============================================================================
// CHAT – resposta natural + apêndice de parceiros
// ============================================================================
application.post("/api/chat/:slugDaRegiao", async (request, response) => {
  console.log("\n--- NOVA INTERAÇÃO ---");
  try {
    const { slugDaRegiao } = request.params;
    let { message: textoDoUsuario, conversationId } = request.body;

    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return response.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    const textoUserTrim = textoDoUsuario.trim();

    // 1) Região
    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", slugDaRegiao)
      .single();
    if (erroRegiao || !regiao) {
      console.error("[SUPABASE] Erro ao carregar região:", erroRegiao);
      return response.status(404).json({ error: `Região com apelido (slug) '${slugDaRegiao}' não encontrada.` });
    }

    // 2) Cidades
    const { data: cidades, error: erroCidades } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", regiao.id);
    if (erroCidades) {
      console.error("[SUPABASE] Erro ao carregar cidades:", erroCidades);
      return response.status(500).json({ error: "Erro ao carregar cidades." });
    }

    // 3) Cidade pelo texto
    const textoMinusculo = textoUserTrim.toLowerCase();
    let cidadeDetectada = null;
    for (const c of cidades || []) {
      if (textoMinusculo.includes(String(c.nome).toLowerCase()) || textoMinusculo.includes(String(c.slug).toLowerCase())) {
        cidadeDetectada = c; break;
      }
    }

    const analise = await analisarEntradaUsuario(textoUserTrim, cidades);
    if (!cidadeDetectada && analise.cidadeSlugSugerida) {
      const cand = (cidades || []).find((c) => c.slug === analise.cidadeSlugSugerida);
      if (cand) cidadeDetectada = cand;
    }

    const perfilUsuario = {
      companhia: analise.companhia,
      vibe: analise.vibe,
      orcamento: analise.orcamento
    };

    // 4) conversationId
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

    // 5) carregar conversa
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

    // 6) analytics (best-effort)
    try {
      await supabase.from("buscas_texto").insert({
        regiao_id: regiao.id,
        cidade_id: cidadeDetectada?.id || null,
        texto: textoUserTrim
      });
      await supabase.from("eventos_analytics").insert({
        regiao_id: regiao.id,
        cidade_id: cidadeDetectada?.id || null,
        conversation_id: conversationId,
        tipo_evento: "search",
        payload: { q: textoUserTrim }
      });
    } catch (e) {
      console.error("[SUPABASE] Falha ao registrar métricas de busca (segue):", e);
    }

    // 7) intenção
    const intencao = detectarIntencaoDeFollowUp(textoUserTrim);

    // 7.1 Seleção por número/nome quando já há sugeridos e a intenção é genérica
    const candidatos = Array.isArray(conversaAtual.parceiros_sugeridos) ? conversaAtual.parceiros_sugeridos : [];
    if (candidatos.length > 0 && intencao === "nenhuma") {
      let escolhido = null;

      const idx = extrairIndiceEscolhido(textoUserTrim);
      if (idx !== null && idx >= 0 && idx < candidatos.length) {
        escolhido = candidatos[idx];
      }
      if (!escolhido) {
        escolhido = tentarAcharParceiroPorNomeOuCategoria(textoUserTrim, candidatos);
      }

      if (escolhido) {
        try {
          const { error: erroUpdConv } = await supabase
            .from("conversas")
            .update({ parceiro_em_foco: escolhido })
            .eq("id", conversationId);
          if (erroUpdConv) throw erroUpdConv;
        } catch (e) {
          console.warn("[SUPABASE] Não consegui salvar foco, guardando em memória:", e);
          salvarConversaMem(conversationId, { parceiro_em_foco: escolhido });
        }

        return response.status(200).json({
          reply: resumoDoParceiro(escolhido),
          interactionId: null,
          photoLinks: Array.isArray(escolhido.fotos_parceiros) ? escolhido.fotos_parceiros : [],
          conversationId
        });
      }
    }

    // 7.2 Follow-ups diretos quando há foco
    if (conversaAtual.parceiro_em_foco && intencao !== "nenhuma") {
      const parceiroAtual = conversaAtual.parceiro_em_foco;

      const registrar = async (respostaDireta) => {
        try {
          await supabase.from("interacoes").insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoUserTrim,
            resposta_ia: respostaDireta,
            parceiros_sugeridos: conversaAtual.parceiros_sugeridos || []
          });
        } catch {}
      };

      if (intencao === "horario") {
        const horario = parceiroAtual.horario_funcionamento ? String(parceiroAtual.horario_funcionamento) : "O parceiro não informou horário de funcionamento.";
        const respostaDireta = `Horário de funcionamento de ${parceiroAtual.nome}: ${horario}`;
        await registrar(respostaDireta);
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
        await registrar(respostaDireta);
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
        await registrar(respostaDireta);
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "fotos") {
        const possuiFotos = Array.isArray(parceiroAtual.fotos_parceiros) && parceiroAtual.fotos_parceiros.length > 0;
        const respostaDireta = possuiFotos ? `Aqui estão algumas fotos de ${parceiroAtual.nome}.` : `Não encontrei fotos de ${parceiroAtual.nome}.`;
        await registrar(respostaDireta);
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: possuiFotos ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "preco") {
        const faixaDePreco = parceiroAtual.faixa_preco ? String(parceiroAtual.faixa_preco) : "Faixa de preço não informada.";
        const respostaDireta = `Faixa de preço de ${parceiroAtual.nome}: ${faixaDePreco}`;
        await registrar(respostaDireta);
        return response.status(200).json({
          reply: respostaDireta,
          interactionId: null,
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }
    }

    // 8) Palavras-chave e termos de reforço
    logStep("INÍCIO - extração de palavras-chave");
    let termos = [];
    const reforcosPorPerfil = [];
    if (analise?.palavrasChave?.length) for (const k of analise.palavrasChave) reforcosPorPerfil.push(String(k).toLowerCase());
    if (perfilUsuario.companhia === "casal" || perfilUsuario.vibe === "romantico") reforcosPorPerfil.push("romantico", "jantar", "vista", "pôr do sol", "vinho");
    if (perfilUsuario.vibe === "tranquilo") reforcosPorPerfil.push("tranquilo", "barco privativo", "praia calma", "silencioso");
    if (perfilUsuario.vibe === "agitado") reforcosPorPerfil.push("balada", "música ao vivo", "bar");
    if (perfilUsuario.vibe === "aventura") reforcosPorPerfil.push("trilha", "mergulho", "passeio de barco");
    if (perfilUsuario.orcamento === "baixo") reforcosPorPerfil.push("bom e barato", "popular");
    if (perfilUsuario.orcamento === "alto") reforcosPorPerfil.push("premium", "sofisticado", "menu degustação");
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
frase: "${textoUserTrim}"
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

    // 9) Buscar itens locais (parceiros e dicas)
    const cidadeIds = cidadeDetectada ? [cidadeDetectada.id] : (cidades || []).map((c) => c.id);

    let consulta = supabase
      .from("parceiros")
      .select("id, tipo, nome, categoria, descricao, beneficio_bepit, endereco, contato, tags, horario_funcionamento, faixa_preco, fotos_parceiros, cidade_id")
      .eq("ativo", true)
      .in("cidade_id", cidadeIds);

    if (termos.length > 0) {
      const partesOR = [];
      for (const t of termos) {
        const wildcard = `*${t}*`;
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

    // Incluir via tags jsonb (OR)
    if (termos.length > 0) {
      for (const t of termos) {
        const { data: itensTag, error: erroTag } = await supabase
          .from("parceiros")
          .select("id, tipo, nome, categoria, descricao, beneficio_bepit, endereco, contato, tags, horario_funcionamento, faixa_preco, fotos_parceiros, cidade_id")
          .eq("ativo", true)
          .in("cidade_id", cidadeIds)
          .contains("tags", [t]);
        if (!erroTag && Array.isArray(itensTag)) {
          for (const p of itensTag) {
            const jaExiste = itens.some(
              (x) =>
                x.nome?.toLowerCase() === p.nome?.toLowerCase() &&
                (x.categoria || "").toLowerCase() === (p.categoria || "").toLowerCase() &&
                (x.endereco || "").toLowerCase() === (p.endereco || "").toLowerCase()
            );
            if (!jaExiste) itens.push(p);
          }
        }
      }
    }

    // 10) Atualizar conversa com foco e sugeridos
    const parceiroEmFoco = itens.length > 0 ? itens[0] : null;
    try {
      const { error: erroUpdConv } = await supabase
        .from("conversas")
        .update({ parceiro_em_foco: parceiroEmFoco, parceiros_sugeridos: itens })
        .eq("id", conversationId);
      if (erroUpdConv) throw erroUpdConv;
    } catch (e) {
      console.warn("[SUPABASE] Erro ao atualizar conversa (memória):", e);
      salvarConversaMem(conversationId, { parceiro_em_foco: parceiroEmFoco, parceiros_sugeridos: itens });
    }

    // 11) Montar contexto textual dos itens (para IA)
    const contextoDeItens =
      itens.length > 0
        ? itens.slice(0, 8).map((p, i) => {
            const etiqueta = p.tipo === "DICA" ? "[DICA]" : "[PARCEIRO]";
            const beneficio = p.beneficio_bepit ? ` | Benefício: ${p.beneficio_bepit}` : "";
            const endereco = p.endereco ? ` | Endereço: ${p.endereco}` : "";
            return `${i + 1}. ${etiqueta} ${p.nome} — ${p.categoria || "—"}${beneficio}${endereco}`;
          }).join("\n")
        : "Nenhum parceiro ou dica encontrado.";

    const nomesCidades = (cidades || []).map((c) => c.nome).join(", ");

    // Heurística simples para saudações: evita listar parceiros nessas mensagens
    const ehSaudacaoOuSmalltalk = (() => {
      const t = textoMinusculo;
      const termos = ["olá", "ola", "oi", "bom dia", "boa tarde", "boa noite", "tudo bem", "e aí", "eaí"];
      return termos.some((k) => t.includes(k));
    })();

    // 12) Geração de resposta natural (IA) + Apêndice de parceiros
    logStep("INÍCIO - geração de resposta final");
    let respostaNatural = "";
    let apendiceParceiros = "";

    // a) Resposta natural sempre vem primeiro
    if (!DISABLE_GEMINI) {
      try {
        const modeloIA = geminiClient.getGenerativeModel({ model: "gemini-1.5-flash" });
        const promptNatural = `
Você é o BEPIT, concierge local, educado e sincero da região ${regiao.nome}.
Regras de resposta:
- Responda de forma direta e útil à pergunta do usuário.
- Se a pergunta for sobre distância, rotas, quando ir, tempo de visita, segurança, melhor época, etc., responda objetivamente.
- Se for saudação ou conversa social, responda de forma breve e amigável, e convide a dizer o que procura.
- Não invente fatos específicos sobre parceiros; dados locais detalhados virão em um bloco de sugestões depois (não invente).

Contexto local:
- Cidades disponíveis: ${nomesCidades}.
- Cidade detectada nesta mensagem: ${cidadeDetectada ? cidadeDetectada.nome : "nenhuma"}.
- Perfil do usuário (se conhecido): companhia=${perfilUsuario.companhia || "?"}, vibe=${perfilUsuario.vibe || "?"}, orçamento=${perfilUsuario.orcamento || "?"}.

Pergunta do usuário:
"${textoUserTrim}"

Responda em 1 a 4 frases, em português do Brasil, sem listas numeradas nesta parte.
`.trim();

        const respIA = await modeloIA.generateContent(promptNatural);
        respostaNatural = (respIA.response.text() || "").trim();
        if (!respostaNatural) throw new Error("IA retornou vazio na parte natural.");
      } catch (e) {
        console.error("[IA Gemini] Falha na resposta natural, usando fallback curto:", e);
        // Fallback curto e neutro
        if (ehSaudacaoOuSmalltalk) {
          respostaNatural = "Olá! Posso te ajudar com **restaurantes**, **passeios**, **praias**, **hospedagem** e mais. O que você procura?";
        } else if (cidadeDetectada) {
          respostaNatural = `Posso te orientar sobre ${cidadeDetectada.nome}: onde comer, o que fazer e como se locomover. Diga o que você quer que eu detalhe.`;
        } else {
          respostaNatural = `Posso te guiar pela ${regiao.nome}. Diga se você busca restaurantes, passeios, praias ou hospedagem — e posso filtrar por cidade (${nomesCidades}).`;
        }
      }
    } else {
      // Gemini desativado: fallback natural
      if (ehSaudacaoOuSmalltalk) {
        respostaNatural = "Olá! Posso te ajudar com **restaurantes**, **passeios**, **praias**, **hospedagem** e mais. O que você procura?";
      } else if (cidadeDetectada) {
        respostaNatural = `Posso te orientar sobre ${cidadeDetectada.nome}: onde comer, o que fazer e como se locomover. Diga o que você quer que eu detalhe.`;
      } else {
        respostaNatural = `Posso te guiar pela ${regiao.nome}. Diga se você busca restaurantes, passeios, praias ou hospedagem — e posso filtrar por cidade (${nomesCidades}).`;
      }
    }

    // b) Apêndice “Sugestões locais” (somente se não for pura saudação ou se usuário pediu algo turístico)
    if (itens.length > 0 && (!ehSaudacaoOuSmalltalk || termos.length > 0)) {
      const top = itens.slice(0, 3).map((p, i) => {
        const benef = p.beneficio_bepit ? ` — Benefício BEPIT: ${p.beneficio_bepit}` : "";
        const cat = p.categoria || "categoria não informada";
        return `${i + 1}. ${p.nome} (${cat})${benef}`;
      }).join("\n");
      apendiceParceiros =
        `\n\n**Sugestões locais**\n${top}\n\n` +
        `Se quiser, responda com o **número** (ex.: 2) ou o **nome** (ex.: "a churrascaria"). ` +
        `Também posso filtrar por cidade (${nomesCidades}).`;
    } else if (itens.length === 0 && !ehSaudacaoOuSmalltalk) {
      apendiceParceiros =
        `\n\n_Não encontrei parceiros dessa categoria agora._ ` +
        `Posso sugerir opções gerais da região, e quando houver oportunidade trago parceiros confiáveis com benefício BEPIT.`;
    }

    const respostaFinal = `${respostaNatural}${apendiceParceiros}`.trim();

    // 13) Métrica de view do foco
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
            .update({ views_total: (registroView.views_total || 0) + 1, last_view_at: new Date().toISOString() })
            .eq("parceiro_id", parceiroEmFoco.id);
          if (errUpdView) throw errUpdView;
        } else {
          const { error: errInsView } = await supabase
            .from("parceiro_views")
            .insert({ parceiro_id: parceiroEmFoco.id, views_total: 1, last_view_at: new Date().toISOString() });
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

    // 14) Registrar interação
    let interactionId = null;
    try {
      const { data: novaInteracao, error: erroInter } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoUserTrim,
          resposta_ia: respostaFinal,
          parceiros_sugeridos: itens
        })
        .select("id")
        .single();
      if (erroInter) throw erroInter;
      interactionId = novaInteracao?.id || null;
    } catch (e) {
      console.error("[SUPABASE] Falha ao salvar interação (segue):", e);
    }

    // 15) Fotos p/ cliente
    const fotosParaCliente =
      parceiroEmFoco && Array.isArray(parceiroEmFoco.fotos_parceiros)
        ? parceiroEmFoco.fotos_parceiros
        : itens.flatMap((p) => (Array.isArray(p.fotos_parceiros) ? p.fotos_parceiros : []));

    return response.status(200).json({
      reply: respostaFinal,
      interactionId,
      photoLinks: fotosParaCliente,
      conversationId
    });
  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return response.status(500).json({ error: "Erro interno no servidor do BEPIT." });
  }
});

// ============================================================================
// FEEDBACK
// ============================================================================
application.post("/api/feedback", async (request, response) => {
  try {
    const { interactionId, feedback } = request.body;

    if (!interactionId || typeof interactionId !== "string") {
      return response.status(400).json({ error: "O campo 'interactionId' é obrigatório e deve ser uma string (uuid)." });
    }
    if (!feedback || typeof feedback !== "string" || feedback.trim().length === 0) {
      return response.status(400).json({ error: "O campo 'feedback' é obrigatório e deve ser uma string não vazia." });
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
// ADMIN (LOGIN)
// ============================================================================
application.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const userOk = username && username === process.env.ADMIN_USER;
    const passOk = password && password === process.env.ADMIN_PASS;

    if (!userOk || !passOk) return res.status(401).json({ error: "Credenciais inválidas" });

    return res.json({ ok: true, adminKey: process.env.ADMIN_API_KEY });
  } catch (e) {
    console.error("[/api/admin/login] erro:", e);
    return res.status(500).json({ error: "erro interno" });
  }
});

// ============================================================================
// ADMIN: PARCEIROS - CRIAR
// ============================================================================
application.post("/api/admin/parceiros", exigirAdminKey, async (request, response) => {
  try {
    const body = request.body;
    const { regiaoSlug, cidadeSlug, ...restante } = body;

    const { data: regiao, error: eReg } = await supabase
      .from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return response.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
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
      fotos_parceiros: Array.isArray(restante.fotos_parceiros) ? restante.fotos_parceiros : (Array.isArray(restante.fotos) ? restante.fotos : null),
      ativo: restante.ativo !== false
    };

    const { data, error } = await supabase.from("parceiros").insert(novoRegistro).select("*").single();
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

// ============================================================================
// ADMIN: PARCEIROS - LISTAR por região+cidade
// ============================================================================
application.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", exigirAdminKey, async (request, response) => {
  try {
    const { regiaoSlug, cidadeSlug } = request.params;

    const { data: regiao, error: eReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return response.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (eCid || !cidade) return response.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase.from("parceiros").select("*").eq("cidade_id", cidade.id).order("nome");
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

// ============================================================================
// ADMIN: PARCEIROS - EDITAR por id
// ============================================================================
application.put("/api/admin/parceiros/:id", exigirAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

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
      fotos_parceiros: Array.isArray(body.fotos_parceiros) ? body.fotos_parceiros : (Array.isArray(body.fotos) ? body.fotos : null),
      ativo: body.ativo !== false
    };

    const { data, error } = await supabase.from("parceiros").update(atualizacao).eq("id", id).select("*").single();
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
// ADMIN: Inclusões de REGIÕES e CIDADES
// ============================================================================
application.post("/api/admin/regioes", exigirAdminKey, async (req, res) => {
  try {
    const { nome, slug, ativo = true } = req.body || {};
    if (!nome || !slug) return res.status(400).json({ error: "nome e slug são obrigatórios" });

    const { data, error } = await supabase.from("regioes").insert({ nome, slug, ativo: Boolean(ativo) }).select("*").single();
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
    if (!regiaoSlug || !nome || !slug) return res.status(400).json({ error: "regiaoSlug, nome e slug são obrigatórios" });

    const { data: regiao, error: eReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
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

// ============================================================================
// ADMIN: MÉTRICAS SIMPLES (contagens e top 5 parceiros por views)
// GET /api/admin/metrics/summary?regiaoSlug=regiao-dos-lagos[&cidadeSlug=cabo-frio]
// ============================================================================
application.get("/api/admin/metrics/summary", exigirAdminKey, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.query;
    if (!regiaoSlug) return res.status(400).json({ error: "regiaoSlug é obrigatório" });

    // Região
    const { data: regiao, error: eReg } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !regiao) return res.status(404).json({ error: "região não encontrada" });

    // Cidades
    const { data: cidades, error: eCid } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", regiao.id);
    if (eCid) return res.status(500).json({ error: "erro ao carregar cidades" });

    let cidade = null;
    let cidadeIds = (cidades || []).map((c) => c.id);
    if (cidadeSlug) {
      cidade = (cidades || []).find((c) => c.slug === cidadeSlug) || null;
      if (!cidade) return res.status(404).json({ error: "cidade não encontrada nesta região" });
      cidadeIds = [cidade.id];
    }

    // Total de parceiros ativos
    const { data: parceirosAtivos, error: eParc } = await supabase
      .from("parceiros")
      .select("id")
      .eq("ativo", true)
      .in("cidade_id", cidadeIds);
    if (eParc) return res.status(500).json({ error: "erro ao contar parceiros" });

    // Total de buscas_texto
    const { data: buscas, error: eBus } = await supabase
      .from("buscas_texto")
      .select("id, cidade_id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (eBus) return res.status(500).json({ error: "erro ao contar buscas" });
    const totalBuscas = (buscas || []).filter((b) => (cidade ? b.cidade_id === cidade.id : true)).length;

    // Total de interações
    const { data: interacoes, error: eInt } = await supabase
      .from("interacoes")
      .select("id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (eInt) return res.status(500).json({ error: "erro ao contar interações" });
    const totalInteracoes = (interacoes || []).length;

    // TOP 5 por views
    const { data: views, error: eViews } = await supabase
      .from("parceiro_views")
      .select("parceiro_id, views_total, last_view_at")
      .order("views_total", { ascending: false })
      .limit(50);
    if (eViews) return res.status(500).json({ error: "erro ao ler views" });

    const parceiroIds = Array.from(new Set((views || []).map((v) => v.parceiro_id)));
    const { data: parceirosInfo } = await supabase
      .from("parceiros")
      .select("id, nome, categoria, cidade_id")
      .in("id", parceiroIds);

    const partnersById = new Map((parceirosInfo || []).map((p) => [p.id, p]));
    const topFiltrado = (views || [])
      .filter((v) => {
        const info = partnersById.get(v.parceiro_id);
        if (!info) return false;
        return cidade ? info.cidade_id === cidade.id : cidadeIds.includes(info.cidade_id);
      })
      .slice(0, 5)
      .map((v) => {
        const info = partnersById.get(v.parceiro_id);
        return {
          parceiro_id: v.parceiro_id,
          nome: info?.nome || "—",
          categoria: info?.categoria || "—",
          views_total: v.views_total,
          last_view_at: v.last_view_at
        };
      });

    return res.json({
      regiao: { id: regiao.id, nome: regiao.nome, slug: regiao.slug },
      cidade: cidade ? { id: cidade.id, nome: cidade.nome, slug: cidade.slug } : null,
      total_parceiros_ativos: (parceirosAtivos || []).length,
      total_buscas: totalBuscas,
      total_interacoes: totalInteracoes,
      top5_parceiros_por_views: topFiltrado
    });
  } catch (e) {
    console.error("[/api/admin/metrics/summary] erro:", e);
    res.status(500).json({ error: "erro interno" });
  }
});

// ============================================================================
// ADMIN: LOGS / EVENTOS (auditoria simples)
// GET /api/admin/logs?tipo=search&regiaoSlug=...&cidadeSlug=...&parceiroId=...&conversationId=...&since=...&until=...&limit=50
// (Corrigido: sem trechos de código estranhos; apenas consulta limpa.)
// ============================================================================
application.get("/api/admin/logs", exigirAdminKey, async (req, res) => {
  try {
    const { tipo, regiaoSlug, cidadeSlug, parceiroId, conversationId, since, until, limit } = req.query;

    // Normaliza limite
    let lim = Number(limit || 50);
    if (!Number.isFinite(lim) || lim <= 0) lim = 50;
    if (lim > 200) lim = 200;

    // Resolve IDs a partir de slugs (se fornecidos)
    let regiaoId = null;
    let cidadeId = null;

    if (regiaoSlug) {
      const { data: regiao, error: eReg } = await supabase
        .from("regioes")
        .select("id, slug")
        .eq("slug", String(regiaoSlug))
        .single();
      if (eReg) {
        console.error("[/api/admin/logs] erro ao buscar região:", eReg);
        return res.status(500).json({ error: "erro ao buscar região" });
      }
      if (!regiao) return res.status(404).json({ error: "região não encontrada" });
      regiaoId = regiao.id;
    }

    if (cidadeSlug && regiaoId) {
      const { data: cidade, error: eCid } = await supabase
        .from("cidades")
        .select("id, slug, regiao_id")
        .eq("slug", String(cidadeSlug))
        .eq("regiao_id", regiaoId)
        .single();
      if (eCid) {
        console.error("[/api/admin/logs] erro ao buscar cidade:", eCid);
        return res.status(500).json({ error: "erro ao buscar cidade" });
      }
      if (!cidade) return res.status(404).json({ error: "cidade não encontrada nesta região" });
      cidadeId = cidade.id;
    }

    // Consulta
    let query = supabase
      .from("eventos_analytics")
      .select("id, created_at, regiao_id, cidade_id, parceiro_id, conversation_id, tipo_evento, payload")
      .order("created_at", { ascending: false })
      .limit(lim);

    if (tipo) query = query.eq("tipo_evento", String(tipo));
    if (regiaoId) query = query.eq("regiao_id", regiaoId);
    if (cidadeId) query = query.eq("cidade_id", cidadeId);
    if (parceiroId) query = query.eq("parceiro_id", String(parceiroId));
    if (conversationId) query = query.eq("conversation_id", String(conversationId));
    if (since) query = query.gte("created_at", String(since));
    if (until) query = query.lte("created_at", String(until));

    const { data, error } = await query;
    if (error) {
      console.error("[/api/admin/logs] erro supabase:", error);
      return res.status(500).json({ error: "erro ao consultar logs" });
    }

    return res.json({ data });
  } catch (e) {
    console.error("[/api/admin/logs] erro inesperado:", e);
    return res.status(500).json({ error: "erro interno" });
  }
});

// ------------------------ Iniciar servidor ------------------------
application.listen(servidorPorta, () => {
  console.log(`✅ BEPIT Nexus rodando em http://localhost:${servidorPorta}`);
});
