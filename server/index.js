// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabaseClient.js";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Faltou GEMINI_API_KEY no .env");
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3002;
// Ajuste com SEU domínio do Netlify
const ORIGENS_PERMITIDAS = [
  "http://localhost:5173",          // dev local
  "https://bepitnexus.netlify.app"  // produção (seu front)
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // permite curl, Postman etc
    if (ORIGENS_PERMITIDAS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS bloqueado para essa origem."));
  },
  credentials: true
}));

app.options("*", cors());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "BEPIT Nexus online", port: String(PORT) });
});

// Utilitário
const slugify = (s) =>
  String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

// Chat por REGIÃO (macro)
app.post("/api/chat/:regiaoSlug", async (req, res) => {
  try {
    const { regiaoSlug } = req.params;
    let { message, conversationId } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message obrigatório" });
    }

    // 1) Carregar REGIÃO e CIDADES
    const { data: regiao, error: errReg } = await supabase
      .from("regioes").select("id, nome, slug").eq("slug", regiaoSlug).single();
    if (errReg || !regiao) return res.status(404).json({ error: `Região '${regiaoSlug}' não encontrada` });

    const { data: cidades, error: errCid } = await supabase
      .from("cidades").select("id, nome, slug").eq("regiao_id", regiao.id);
    if (errCid) return res.status(500).json({ error: "Erro ao carregar cidades" });

    // 2) Detectar cidade pela frase
    const lower = message.toLowerCase();
    let cidadeDetectada = null;
    for (const c of (cidades || [])) {
      const nome = String(c.nome).toLowerCase();
      const slug = String(c.slug).toLowerCase();
      if (lower.includes(nome) || lower.includes(slug)) { cidadeDetectada = c; break; }
    }

    // 3) Criar conversa se faltar
    if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
      conversationId = randomUUID();
      await supabase.from("conversas").insert({
        id: conversationId,
        regiao_id: regiao.id,
        parceiro_em_foco: null,
        parceiros_sugeridos: [],
        ultima_pergunta_usuario: null,
        ultima_resposta_ia: null
      });
    }

    // 4) Registrar busca de texto (para métricas)
    await supabase.from("buscas_texto").insert({
      regiao_id: regiao.id,
      cidade_id: cidadeDetectada?.id || null,
      texto: message
    });
    await supabase.from("eventos_analytics").insert({
      regiao_id: regiao.id,
      cidade_id: cidadeDetectada?.id || null,
      conversation_id: conversationId,
      tipo_evento: "search",
      payload: { q: message }
    });

    // 5) Palavras-chave (Gemini)
    const modelo = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const promptKW = `
extraia até 3 palavras-chave de turismo da frase abaixo.
regras:
- responda apenas com as palavras separadas por vírgula.
- minúsculas, sem explicações.
- se não achar, responda "geral".
frase: "${message}"
`.trim();
    const respKW = await modelo.generateContent(promptKW);
    const kwRaw = (await respKW.response.text()).trim();
    const kwLine = (kwRaw.split("\n")[0] || "").replace(/["'“”‘’]/g, "");
    const base = kwLine.split(",").map((x)=>x.trim().toLowerCase()).filter(Boolean);
    const termos = Array.from(new Set([
      ...base,
      ...base.map(p => (p.endsWith("s") ? p.slice(0,-1) : `${p}s`))
    ])).filter(p => p.length >= 3);

    // 6) Buscar parceiros/dicas na(s) cidade(s)
    const cidadeIds = cidadeDetectada ? [cidadeDetectada.id] : (cidades||[]).map(c=>c.id);
    let q = supabase.from("parceiros").select(
      "id, tipo, nome, categoria, descricao, beneficio_bepit, endereco, contato, tags, horario_funcionamento, faixa_preco, fotos, cidade_id"
    ).eq("ativo", true).in("cidade_id", cidadeIds);

    if (termos.length > 0) {
      const orParts = [];
      for (const t of termos) {
        orParts.push(`tags.cs.${JSON.stringify([t])}`);
        orParts.push(`categoria.ilike.%${t}%`);
        orParts.push(`nome.ilike.%${t}%`);
      }
      q = q.or(orParts.join(","));
    }

    const { data: itens, error: errParc } = await q;
    if (errParc) return res.status(500).json({ error: "Falha ao consultar parceiros/dicas" });

    // 7) Escolher foco e montar contexto
    const parceiroEmFoco = Array.isArray(itens) && itens.length > 0 ? itens[0] : null;
    await supabase.from("conversas").update({
      parceiro_em_foco: parceiroEmFoco,
      parceiros_sugeridos: itens
    }).eq("id", conversationId);

    const contexto = (itens && itens.length)
      ? itens.map(p => {
          const tag = p.tipo === "DICA" ? "[DICA]" : "[PARCEIRO]";
          return `${tag} ${p.nome} — ${p.categoria||"—"} — ${p.endereco||"—"}`;
        }).slice(0, 10).join("\n")
      : "Nenhum item encontrado.";

    // 8) Montar resposta
    const listaCidades = (cidades||[]).map(c=>c.nome).join(", ");
    const promptFinal = `
Você é o BEPIT (concierge) da região ${regiao.nome}.
Responda curto (2-4 frases), priorizando parceiros/dicas encontrados.
Se cidade foi informada, foque nela; se não, mencione que pode filtrar por: ${listaCidades}.

[Contexto]
Cidade detectada: ${cidadeDetectada ? cidadeDetectada.nome : "nenhuma"}
Itens (até 10):
${contexto}

[Pergunta do usuário]
"${message}"
`.trim();

    const out = await modelo.generateContent(promptFinal);
    const texto = out.response.text();

    // 9) Analytics: se houve parceiro em foco, conta view
    if (parceiroEmFoco?.id) {
      // incrementa views
      await supabase.rpc("noop"); // placeholder se quiser testar sem função
      const { data: cur } = await supabase.from("parceiro_views").select("*").eq("parceiro_id", parceiroEmFoco.id).single();
      if (cur) {
        await supabase.from("parceiro_views").update({ views_total: cur.views_total + 1, last_view_at: new Date().toISOString() }).eq("parceiro_id", parceiroEmFoco.id);
      } else {
        await supabase.from("parceiro_views").insert({ parceiro_id: parceiroEmFoco.id, views_total: 1, last_view_at: new Date().toISOString() });
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

    // 10) Salvar interação
    const { data: inter } = await supabase.from("interacoes")
      .insert({
        regiao_id: regiao.id,
        conversation_id: conversationId,
        pergunta_usuario: message,
        resposta_ia: texto,
        parceiros_sugeridos: itens
      }).select("id").single();

    const fotos = parceiroEmFoco?.fotos && Array.isArray(parceiroEmFoco.fotos)
      ? parceiroEmFoco.fotos
      : (itens||[]).flatMap(p => Array.isArray(p.fotos) ? p.fotos : []);

    return res.status(200).json({
      reply: texto,
      interactionId: inter?.id || null,
      photoLinks: fotos,
      conversationId
    });

  } catch (e) {
    console.error("[/api/chat/:regiaoSlug] Erro:", e);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// Feedback → grava e também registra analytics
app.post("/api/feedback", async (req, res) => {
  try {
    const { interactionId, feedback } = req.body;
    if (!interactionId || typeof interactionId !== "string") {
      return res.status(400).json({ error: "interactionId inválido" });
    }
    if (!feedback || typeof feedback !== "string" || !feedback.trim()) {
      return res.status(400).json({ error: "feedback vazio" });
    }
    await supabase.from("interacoes").update({ feedback_usuario: feedback }).eq("id", interactionId);
    await supabase.from("eventos_analytics").insert({ tipo_evento: "feedback", payload: { interactionId, feedback } });
    res.json({ success: true });
  } catch (e) {
    console.error("[/api/feedback] Erro:", e);
    res.status(500).json({ error: "Erro ao registrar feedback" });
  }
});

// ====================== ADMIN BÁSICO ======================

// Criar parceiro/dica
app.post("/api/admin/parceiros", async (req, res) => {
  try {
    const body = req.body;
    // Espera: { cidadeSlug, regiaoSlug, tipo, nome, ... }
    const { regiaoSlug, cidadeSlug, ...rest } = body;
    const { data: reg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (!reg) return res.status(400).json({ error: "regiaoSlug inválido" });
    const { data: cid } = await supabase.from("cidades").select("id").eq("regiao_id", reg.id).eq("slug", cidadeSlug).single();
    if (!cid) return res.status(400).json({ error: "cidadeSlug inválido" });

    const novo = {
      cidade_id: cid.id,
      tipo: rest.tipo || "PARCEIRO",
      nome: rest.nome,
      descricao: rest.descricao || null,
      categoria: rest.categoria || null,
      beneficio_bepit: rest.beneficio_bepit || null,
      endereco: rest.endereco || null,
      contato: rest.contato || null,
      tags: Array.isArray(rest.tags) ? rest.tags : null,
      horario_funcionamento: rest.horario_funcionamento || null,
      faixa_preco: rest.faixa_preco || null,
      fotos: Array.isArray(rest.fotos) ? rest.fotos : null,
      ativo: rest.ativo !== false
    };

    const { data, error } = await supabase.from("parceiros").insert(novo).select("*").single();
    if (error) return res.status(500).json({ error: "Erro ao criar parceiro/dica" });
    res.json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/parceiros] Erro:", e);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Lista parceiros por região/cidade
app.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.params;
    const { data: reg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (!reg) return res.status(400).json({ error: "regiaoSlug inválido" });
    const { data: cid } = await supabase.from("cidades").select("id").eq("regiao_id", reg.id).eq("slug", cidadeSlug).single();
    if (!cid) return res.status(400).json({ error: "cidadeSlug inválido" });

    const { data, error } = await supabase.from("parceiros").select("*").eq("cidade_id", cid.id).order("nome");
    if (error) return res.status(500).json({ error: "Erro ao listar" });
    res.json({ data });
  } catch (e) {
    console.error("[/api/admin/parceiros/:regiao/:cidade] Erro:", e);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ BEPIT Nexus rodando em http://localhost:${PORT}`);
});
