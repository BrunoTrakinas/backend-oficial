// F:\uber-chat-mvp\backend-oficial\server\index.js
// ============================================================================
// BEPIT Nexus - Servidor (Express)
// - Carrega .env antes de qualquer import que use process.env
// - Suporta conversa com contexto (conversationId) e follow-ups diretos
// - Organização por REGIÃO → CIDADES → PARCEIROS/DICAS
// - Métricas básicas e proteção contra erros (guard rails)
// ============================================================================
import "dotenv/config";

import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabaseClient.js";

// Exemplo de rota para listar parceiros ativos
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
// MIDDLEWARE: protege rotas de admin com chave no header X-Admin-Key
// ============================================================================
function exigirAdminKey(req, res, next) {
  const header = req.headers["x-admin-key"];
  if (!header || header !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "admin key inválida ou ausente" });
  }
  next();
}

// ============================== CONFIG BÁSICA ===============================
const application = express();
const servidorPorta = process.env.PORT || 3002;

// Origens permitidas (ajuste aqui se seu domínio mudar)
// CORS flexível p/ localhost e Netlify (produção + previews)
const allowOrigin = (origin) => {
  if (!origin) return true; // permite Postman/cURL

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

application.options("*", cors());
application.use(express.json());

// Cliente Gemini
const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== DEBUG/SAFE MODE =====
// Ative DISABLE_GEMINI=1 no .env para pular chamadas à IA (útil p/ testes)
const DISABLE_GEMINI = process.env.DISABLE_GEMINI === "1";

// Helpers de log
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

// ------------------------ Healthcheck ------------------------
application.get("/health", (request, response) => {
  response.status(200).json({
    ok: true,
    message: "Servidor BEPIT Nexus online",
    port: String(servidorPorta)
  });
});

// ------------------------ Detecção de follow-up ------------------------
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

// === Analisar entrada do usuário (corrigir, inferir perfil, cidade e palavras) ===
async function analisarEntradaUsuario(texto, cidades) {
  // Fallback simples quando a IA estiver desligada
  if (process.env.DISABLE_GEMINI === "1") {
    const lower = String(texto || "").toLowerCase();
    const cidadeSlug = (cidades || []).find(
      (c) => lower.includes(String(c.nome).toLowerCase()) || lower.includes(String(c.slug).toLowerCase())
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
      return response.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }

    // 1) Carregar a REGIÃO
    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", slugDaRegiao)
      .single();

    if (erroRegiao || !regiao) {
      console.error("[SUPABASE] Erro ao carregar região:", erroRegiao);
      return response.status(404).json({ error: `Região com apelido (slug) '${slugDaRegiao}' não encontrada.` });
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
      const { error: erroCriarConversa } = await supabase.from("conversas").insert({
        id: conversationId,
        regiao_id: regiao.id,
        parceiro_em_foco: null,
        parceiros_sugeridos: [],
        ultima_pergunta_usuario: null,
        ultima_resposta_ia: null
      });
      if (erroCriarConversa) {
        console.error("[SUPABASE] Erro ao criar conversa:", erroCriarConversa);
        return response.status(500).json({ error: "Erro ao iniciar conversa." });
      }
    }

    // 5) Carregar conversa atual (para follow-ups)
    const { data: conversaAtual, error: erroConversa } = await supabase
      .from("conversas")
      .select("id, parceiro_em_foco, parceiros_sugeridos")
      .eq("id", conversationId)
      .single();

    if (erroConversa || !conversaAtual) {
      console.error("[SUPABASE] Erro ao carregar conversa:", erroConversa);
      return response.status(404).json({ error: "Conversa não encontrada." });
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

    // 7) Follow-ups diretos se houver parceiro em foco
    const intencao = detectarIntencaoDeFollowUp(textoDoUsuario);
    if (conversaAtual.parceiro_em_foco && intencao !== "nenhuma") {
      const parceiroAtual = conversaAtual.parceiro_em_foco;

      if (intencao === "horario") {
        const horario = parceiroAtual.horario_funcionamento
          ? String(parceiroAtual.horario_funcionamento)
          : "O parceiro não informou horário de funcionamento.";
        const respostaDireta = `Horário de funcionamento de ${parceiroAtual.nome}: ${horario}`;

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
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "endereco") {
        const endereco = parceiroAtual.endereco ? String(parceiroAtual.endereco) : "Endereço não informado.";
        const respostaDireta = `Endereço de ${parceiroAtual.nome}: ${endereco}`;

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
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "contato") {
        const contato = parceiroAtual.contato ? String(parceiroAtual.contato) : "Contato não informado.";
        const respostaDireta = `Contato de ${parceiroAtual.nome}: ${contato}`;

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
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "fotos") {
        const possuiFotos = Array.isArray(parceiroAtual.fotos_parceiros) && parceiroAtual.fotos_parceiros.length > 0;
        const respostaDireta = possuiFotos
          ? `Aqui estão algumas fotos de ${parceiroAtual.nome}.`
          : `Não encontrei fotos de ${parceiroAtual.nome}.`;

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
          photoLinks: possuiFotos ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }

      if (intencao === "preco") {
        const faixaDePreco = parceiroAtual.faixa_preco ? String(parceiroAtual.faixa_preco) : "Faixa de preço não informada.";
        const respostaDireta = `Faixa de preço de ${parceiroAtual.nome}: ${faixaDePreco}`;

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
          photoLinks: Array.isArray(parceiroAtual.fotos_parceiros) ? parceiroAtual.fotos_parceiros : [],
          conversationId
        });
      }
    }

    // Follow-up sem foco mas com vários sugeridos
    if (
      !conversaAtual.parceiro_em_foco &&
      intencao !== "nenhuma" &&
      Array.isArray(conversaAtual.parceiros_sugeridos) &&
      conversaAtual.parceiros_sugeridos.length > 1
    ) {
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
        conversationId
      });
    }

    // 8) Palavras-chave via Gemini (com fallback seguro)
    logStep("INÍCIO - extração de palavras-chave");
    let termos = [];

    // Reforços de termos com base no perfil inferido + termos da análise
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

    // 9) Buscar parceiros/dicas
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
    const { error: erroUpdConv } = await supabase
      .from("conversas")
      .update({
        parceiro_em_foco: parceiroEmFoco,
        parceiros_sugeridos: itens
      })
      .eq("id", conversationId);

    if (erroUpdConv) {
      console.error("[SUPABASE] Erro ao atualizar conversa (segue):", erroUpdConv);
    }

    // 11) Montar contexto
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
        return `Aqui vão algumas opções${foco}: ${top}. Se quiser, posso filtrar por cidade (${listaCidades}).`;
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

    // 13) Métrica de visualização do parceiro em foco (não derrubar rota se falhar)
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

// === LOGIN DO ADMIN (MVP) ===
// POST /api/admin/login  { username, password }
// Se bater com ADMIN_USER e ADMIN_PASS, devolve { ok:true, adminKey: <ADMIN_API_KEY> }
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
// ADMIN BÁSICO (MVP): criar/listar/editar parceiros via backend (sem expor chaves)
// ============================================================================

// CRIAR parceiro/dica
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

// LISTAR parceiros por região+cidade
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

// EDITAR parceiro por id
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
// ADMIN: Inclusões de REGIÕES e CIDADES
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

// ============================================================================
// ADMIN: MÉTRICAS SIMPLES (contagens e top 5 parceiros por views)
// GET /api/admin/metrics/summary?regiaoSlug=regiao-dos-lagos[&cidadeSlug=cabo-frio]
// ============================================================================
application.get("/api/admin/metrics/summary", exigirAdminKey, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.query;
    if (!regiaoSlug) return res.status(400).json({ error: "regiaoSlug é obrigatório" });

    // Carrega região
    const { data: regiao, error: eReg } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !regiao) return res.status(404).json({ error: "região não encontrada" });

    // Carrega cidades da região
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

    // Total de parceiros ativos na região/cidade
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
    const totalInteracoes = (interacoes || []).length; // (não temos cidade_id em interacoes no MVP)

    // TOP 5 parceiros por views
    const { data: views, error: eViews } = await supabase
      .from("parceiro_views")
      .select("parceiro_id, views_total, last_view_at")
      .order("views_total", { ascending: false })
      .limit(50); // pega mais e filtramos por cidade abaixo
    if (eViews) return res.status(500).json({ error: "erro ao ler views" });

    // Junte com parceiros para filtrar por cidade
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
// Protegida por X-Admin-Key
// ============================================================================
application.get("/api/admin/logs", exigirAdminKey, async (req, res) => {
  try {
    const {
      tipo,              // ex.: "search" | "partner_view" | "feedback"
      regiaoSlug,        // ex.: "regiao-dos-lagos"
      cidadeSlug,        // ex.: "cabo-frio"
      parceiroId,        // UUID do parceiro
      conversationId,    // UUID da conversa
      since,             // ISO datetime (ex.: 2025-09-01T00:00:00Z)
      until,             // ISO datetime
      limit              // quantidade de linhas
    } = req.query;

    // Normaliza o limite (padrão 50, máximo 200)
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

    // Monta consulta
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
