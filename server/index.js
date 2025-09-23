import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { supabase } from "../lib/supabaseClient.js";

dotenv.config();

// Validações críticas das chaves
if (!process.env.GEMINI_API_KEY) {
  console.error("ERRO CRÍTICO: Variável GEMINI_API_KEY não encontrada.");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("ERRO CRÍTICO: Variáveis do Supabase não encontradas.");
  process.exit(1);
}

const application = express();
const serverPort = process.env.PORT || 3002;

const googleGenerativeAIClient = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

// Configuração de CORS para produção e desenvolvimento
const allowedOrigins = [
  "http://localhost:5173",
  "https://bepitnexus.netlify.app"
];
const crossOriginResourceSharingOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Não permitido pela política de CORS'));
    }
  }
};
application.use(cors(crossOriginResourceSharingOptions));
application.options("*", cors(crossOriginResourceSharingOptions));
application.use(express.json());

application.get("/health", (request, response) => {
  response.status(200).json({ ok: true });
});

// A ROTA AGORA É DINÂMICA E RECEBE O "slug" DA REGIÃO
application.post("/api/chat/:slugDaRegiao", async (request, response) => {
  try {
    const { slugDaRegiao } = request.params; // 1. Capturamos a região da URL
    const { message: userMessageText } = request.body;

    if (!userMessageText || typeof userMessageText !== "string") {
      return response.status(400).json({ error: "Campo 'message' é obrigatório." });
    }

    // 2. Buscamos as informações da região no banco de dados
    const { data: regiao, error: regiaoError } = await supabase
      .from('regioes')
      .select('id, nome_regiao')
      .eq('slug', slugDaRegiao)
      .single(); // .single() garante que pegamos apenas um resultado

    if (regiaoError || !regiao) {
      console.error(`Região com slug '${slugDaRegiao}' não encontrada.`);
      return response.status(404).json({ error: "Região não encontrada." });
    }

    const generativeModel = googleGenerativeAIClient.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Lógica de extração de palavras-chave (permanece igual)
    const keywordExtractionPrompt = `Extraia até 3 palavras-chave de busca (tags) da seguinte frase, relacionadas a turismo. Responda apenas com as palavras separadas por vírgula. Frase: "${userMessageText}"`;
    const keywordResult = await generativeModel.generateContent(keywordExtractionPrompt);
    const keywordsText = await keywordResult.response.text();
    const keywords = keywordsText.split(',').map(kw => kw.trim().toLowerCase()).filter(kw => kw);

    // 3. A busca de parceiros agora filtra pela região correta
    let parceiros = [];
    if (keywords.length > 0) {
      const { data, error } = await supabase
        .from('parceiros')
        .select('nome, descricao, beneficio_bepit, endereco, faixa_preco, contato_telefone, link_fotos')
        .eq('regiao_id', regiao.id) // << FILTRO CRUCIAL PELA REGIÃO!
        .or(`tags.cs.{${keywords.join(',')}}`); // Busca por tags
      
      if (error) throw error;
      parceiros = data;
    }
    
    // Lógica para montar o contexto dos parceiros (permanece igual)
    let parceirosContexto = "Nenhum parceiro específico encontrado em nossa base de dados para esta pergunta.";
    if (parceiros && parceiros.length > 0) {
      parceirosContexto = "Baseado na sua pergunta, encontrei estes parceiros oficiais no nosso banco de dados:\n" + parceiros.map(p => 
        `- Nome: ${p.nome}\n  - Descrição: ${p.descricao}\n  - Benefício Exclusivo BEPIT: ${p.beneficio_bepit}\n  - Endereço: ${p.endereco}`
      ).join('\n\n');
    }

    // 4. O prompt agora é dinâmico, mencionando a região correta!
    const finalPrompt = `
      [CONTEXTO]
      Você é o BEPIT, um assistente de viagem especialista e confiável da **${regiao.nome_regiao}**.

      [PARCEIROS RELEVANTES ENCONTRADOS NO BANCO DE DADOS]
      ${parceirosContexto}

      [REGRAS INEGOCIÁVEIS]
      1. Se a lista de parceiros relevantes não estiver vazia, BASEIE SUA RESPOSTA nela. Responda de forma conversada.
      2. Você é proibido de sugerir que o usuário pesquise em outras fontes. VOCÊ é a fonte.
      3. Se a lista de parceiros relevantes estiver vazia, use seu conhecimento geral para ajudar o usuário.
      4. Responda APENAS sobre turismo na ${regiao.nome_regiao}. Para outros assuntos, recuse educadamente.

      [PERGUNTA DO USUÁRIO]
      "${userMessageText}"
    `.trim();

    const modelResult = await generativeModel.generateContent(finalPrompt);
    const modelResponse = await modelResult.response;
    const modelText = modelResponse.text();

    return response.status(200).json({ reply: modelText });

  } catch (error) {
    console.error("[/api/chat] Erro interno:", error);
    return response.status(500).json({ error: "Erro interno no cérebro do robô." });
  }
});

application.listen(serverPort, () => {
  console.log(`🤖 Cérebro OFICIAL do BEPIT Nexus (Multi-Região) rodando na porta ${serverPort}`);
});
