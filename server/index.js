import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { supabase } from "../lib/supabaseClient.js";

dotenv.config();

// Validações críticas das chaves de ambiente
if (!process.env.GEMINI_API_KEY) {
  console.error("ERRO CRÍTICO: Variável de ambiente GEMINI_API_KEY não encontrada.");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("ERRO CRÍTICO: Variáveis de ambiente do Supabase não encontradas.");
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

// Rota de saúde para testes
application.get("/health", (request, response) => {
  response.status(200).json({ ok: true });
});

// Rota de chat multi-região
application.post("/api/chat/:slugDaRegiao", async (request, response) => {
  try {
    const { slugDaRegiao } = request.params;
    const { message: userMessageText } = request.body;

    if (!userMessageText || typeof userMessageText !== "string") {
      return response.status(400).json({ error: "Campo 'message' é obrigatório." });
    }
    
    const { data: regiao, error: regiaoError } = await supabase.from('regioes').select('id, nome_regiao').eq('slug', slugDaRegiao).single();
    if (regiaoError || !regiao) {
      throw new Error(`Região '${slugDaRegiao}' não encontrada.`);
    }

    const generativeModel = googleGenerativeAIClient.getGenerativeModel({ model: "gemini-1.5-flash" });

    const keywordExtractionPrompt = `Sua única tarefa é extrair até 3 palavras-chave de busca (tags) da frase do usuário abaixo, relacionadas a turismo. Responda APENAS com as palavras separadas por vírgula, sem nenhuma outra frase ou explicação. Se não encontrar nenhuma tag, responda com a palavra "geral".
Exemplo 1: "onde comer uma pizza boa?" -> "pizza, restaurante, comer"
Exemplo 2: "qual a história da cidade?" -> "geral"
Frase: "${userMessageText}"`;
    
    const keywordResult = await generativeModel.generateContent(keywordExtractionPrompt);
    const keywordsText = (await keywordResult.response.text()).trim();
    const firstLineOfKeywords = keywordsText.split('\n')[0];
    const keywords = firstLineOfKeywords.split(',').map(kw => kw.trim().toLowerCase());
    
    const { data: parceiros, error } = await supabase
      .from('parceiros')
      .select('nome, descricao, beneficio_bepit, endereco, faixa_preco, contato_telefone, link_fotos')
      .eq('regiao_id', regiao.id)
      .or(`tags.cs.{${keywords.join(',')}}`);

    if (error) {
        console.error("Erro ao buscar parceiros no Supabase:", error);
        throw new Error("Falha ao consultar o banco de dados.");
    }

    let parceirosContexto = "Nenhum parceiro específico encontrado em nossa base de dados para esta pergunta.";
    if (parceiros && parceiros.length > 0) {
      parceirosContexto = "Baseado na sua pergunta, encontrei estes parceiros oficiais no nosso banco de dados:\n" + parceiros.map(p => 
        `- Nome: ${p.nome}\n  - Descrição: ${p.descricao}\n  - Benefício Exclusivo BEPIT: ${p.beneficio_bepit}\n  - Endereço: ${p.endereco}`
      ).join('\n\n');
    }

    const finalPrompt = `
[CONTEXTO]
Você é o BEPIT, um assistente de viagem especialista e confiável da ${regiao.nome_regiao}. Sua missão é dar as melhores dicas locais e autênticas, ajudando o usuário a economizar e aproveitar como um morador local.

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

    const { data: newInteraction, error: insertError } = await supabase.from('interacoes').insert({
      regiao_id: regiao.id,
      pergunta_usuario: userMessageText,
      resposta_ia: modelText,
      parceiros_sugeridos: parceiros || []
    }).select('id').single();

    if (insertError) {
      console.error("Erro ao salvar interação no Supabase:", insertError);
    }

    return response.status(200).json({ 
      reply: modelText,
      interactionId: newInteraction?.id
    });

  } catch (error) {
    console.error("[/api/chat] Erro interno:", error);
    return response.status(500).json({ error: "Erro interno no cérebro do robô." });
  }
});

// Nova rota para receber o feedback
application.post("/api/feedback", async (request, response) => {
    try {
        const { interactionId, feedback } = request.body;

        if (!interactionId || !feedback) {
            return response.status(400).json({ error: "ID da interação e feedback são obrigatórios." });
        }

        const { error } = await supabase
            .from('interacoes')
            .update({ feedback_usuario: feedback })
            .eq('id', interactionId);

        if (error) {
            throw new Error(error.message);
        }

        return response.status(200).json({ success: true });

    } catch (error) {
        console.error("[/api/feedback] Erro interno:", error);
        return response.status(500).json({ error: "Erro ao registrar feedback." });
    }
});

application.listen(serverPort, () => {
  console.log(`🤖 Cérebro OFICIAL do BEPIT Nexus (com Métricas) rodando na porta ${serverPort}`);
});