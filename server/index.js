// ===================================================================================
// ARQUIVO PRINCIPAL DO SERVIDOR (O "CÉREBRO" DO BEPIT)
// VERSÃO 1.5 - "RAIO-X" PARA DIAGNÓSTICO
// ===================================================================================

// --- PASSO 1: Importando nossas ferramentas ---
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { supabase } from "../lib/supabaseClient.js";

dotenv.config();

// Verificação de segurança
if (!process.env.GEMINI_API_KEY) {
  console.error("ERRO CRÍTICO: Chave secreta do Gemini não encontrada!");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("ERRO CRÍTICO: Chaves secretas do Supabase não encontradas!");
  process.exit(1);
}

// --- PASSO 3: Montando o servidor ---
const application = express();
const serverPort = process.env.PORT || 3002;
const googleGenerativeAIClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- PASSO 4: Configurando o "Porteiro" (CORS) ---
const allowedOrigins = [
  "http://localhost:5173",
  "https://bepitnexus.netlify.app"
];
const crossOriginResourceSharingOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Acesso negado pelo CORS!'));
    }
  }
};
application.use(cors(crossOriginResourceSharingOptions));
application.options("*", cors(crossOriginResourceSharingOptions));
application.use(express.json());

// Rota de teste
application.get("/health", (request, response) => {
  response.status(200).json({ ok: true, message: "Servidor BEPIT está online." });
});

// ===================================================================================
// ROTA PRINCIPAL DO CHAT (O CORAÇÃO DA OPERAÇÃO)
// ===================================================================================
application.post("/api/chat/:slugDaRegiao", async (request, response) => {
  console.log("\n--- INÍCIO DE UMA NOVA INTERAÇÃO ---"); // CÂMERA DE SEGURANÇA

  try {
    // --- ETAPA A: Entendendo o pedido ---
    const { slugDaRegiao } = request.params;
    const { message: userMessageText } = request.body;
    console.log(`[CÂMERA 1] Mensagem recebida do usuário: "${userMessageText}" na região: "${slugDaRegiao}"`); // CÂMERA DE SEGURANÇA

    if (!userMessageText || typeof userMessageText !== "string") {
      return response.status(400).json({ error: "O campo 'message' é obrigatório." });
    }
    
    const { data: regiao, error: regiaoError } = await supabase.from('regioes').select('id, nome_regiao').eq('slug', slugDaRegiao).single();
    if (regiaoError || !regiao) {
      throw new Error(`Região com apelido '${slugDaRegiao}' não encontrada.`);
    }

    const generativeModel = googleGenerativeAIClient.getGenerativeModel({ model: "gemini-1.5-flash" });

    // --- ETAPA B: Virando um "Detetive" de Palavras-Chave ---
    const keywordExtractionPrompt = `Sua única tarefa é extrair até 3 palavras-chave de busca (tags) da frase do usuário abaixo, relacionadas a turismo. Responda APENAS com as palavras separadas por vírgula, em minúsculas, sem nenhuma outra frase ou explicação. Se não encontrar nenhuma tag, responda com a palavra "geral". Exemplo: "onde comer uma pizza boa?" -> "pizza, restaurante, comer". Frase: "${userMessageText}"`;
    
    const keywordResult = await generativeModel.generateContent(keywordExtractionPrompt);
    const keywordsText = (await keywordResult.response.text()).trim();
    const firstLineOfKeywords = keywordsText.split('\n')[0];
    const keywords = firstLineOfKeywords.split(',').map(kw => kw.trim().toLowerCase());
    console.log(`[CÂMERA 2] Keywords extraídas pela IA: [${keywords.join(', ')}]`); // CÂMERA DE SEGURANÇA

    const searchKeywords = [...keywords];
    keywords.forEach(kw => {
        if (kw.endsWith('s')) {
            searchKeywords.push(kw.slice(0, -1));
        }
    });
    console.log(`[CÂMERA 3] Termos finais para a busca no banco: [${searchKeywords.join(', ')}]`); // CÂMERA DE SEGURANÇA
    
    // --- ETAPA C: "Pescando" Parceiros no Banco de Dados ---
    const { data: parceiros, error } = await supabase
      .from('parceiros')
      .select('nome, categoria, descricao, beneficio_bepit, endereco, faixa_preco, contato_telefone, link_fotos')
      .eq('regiao_id', regiao.id)
      .or(`tags.cs.{${searchKeywords.join(',')}},categoria.ilike.%${searchKeywords[0]}%`);

    if (error) {
        console.error("Erro ao buscar parceiros no Supabase:", error);
        throw new Error("Falha ao consultar o banco de dados de parceiros.");
    }

    // CÂMERA DE SEGURANÇA para verificar o resultado da busca
    if (parceiros && parceiros.length > 0) {
      console.log(`[CÂMERA 4] SUCESSO! Encontrados ${parceiros.length} parceiros. O primeiro é: ${parceiros[0].nome}`);
    } else {
      console.log(`[CÂMERA 4] FALHA! Nenhum parceiro foi encontrado no banco de dados com os termos da busca.`);
    }

    // --- ETAPA D: Montando o "Dossiê" para a IA ---
    let parceirosContexto = "Nenhum parceiro específico encontrado.";
    if (parceiros && parceiros.length > 0) {
      parceirosContexto = "Parceiros Encontrados:\n" + parceiros.map(p => 
        `- Nome: ${p.nome}\n  - Descrição: ${p.descricao}\n  - Endereço: ${p.endereco}\n  - Benefício Exclusivo BEPIT: ${p.beneficio_bepit}`
      ).join('\n\n');
    }

    // --- ETAPA E: Dando as Ordens Finais para a IA (O Prompt) ---
    const finalPrompt = `
[OBJETIVO PRINCIPAL]
Você é o BEPIT, o concierge especialista e confiável da ${regiao.nome_regiao}. Sua única missão é fornecer respostas rápidas, úteis e baseadas PRIMARIAMENTE nos parceiros encontrados.
[DADOS DE PARCEIROS ENCONTRADOS PARA ESTA PERGUNTA]
${parceirosContexto}
[HIERARQUIA DE REGRAS (SEMPRE SIGA ESTA ORDEM)]
REGRA 1 - PRIORIDADE ABSOLUTA AOS PARCEIROS:
- SE a seção [DADOS DE PARCEIROS ENCONTRADOS] NÃO contiver "Nenhum parceiro específico encontrado", sua resposta DEVE OBRIGATORIAMENTE ser uma recomendação direta e conversada sobre eles.
- Apresente os parceiros de forma natural. Exemplo: "Para uma ótima pizza na região, eu recomendo a Pizzaria do Zé. Eles oferecem..."
- NUNCA diga "encontrei estes parceiros no meu banco de dados". Aja como se a recomendação fosse sua.
- SE a lista de parceiros estiver vazia, e APENAS NESSE CASO, você pode usar seu conhecimento geral, seguindo a REGRA 2.
REGRA 2 - RESPOSTAS SEM PARCEIROS (CONHECIMENTO GERAL):
- Quando não houver parceiros, seja útil e responda à pergunta do usuário sobre a ${regiao.nome_regiao} com informações factuais e de conhecimento público (praias, shoppings, pontos turísticos).
- É PERMITIDO e INCENTIVADO que você forneça endereços, descrições e dicas sobre locais públicos.
REGRA 3 - ESTILO E TOM DE VOZ:
- CONCISÃO É REI: Suas respostas devem ser curtas e diretas. Idealmente, entre 2 e 4 frases. O usuário precisa de informação rápida.
- NUNCA peça mais informações ao usuário (como "qual seu orçamento?"). Responda com o que você tem.
- SIGILO COMERCIAL: Se perguntado se os parceiros pagam, responda: "Nossas sugestões são baseadas em uma curadoria cuidadosa e na opinião de moradores locais para garantir a melhor experiência para você."
REGRA 4 - ESCOPO E LIMITAÇÕES:
- Responda APENAS sobre turismo, serviços e locais na ${regiao.nome_regiao}.
- Para qualquer outro assunto, recuse com a frase: 'Desculpe, meu foco é ser seu melhor guia na ${regiao.nome_regiao}. Como posso te ajudar por aqui?'
[PERGUNTA DO USUÁRIO]
"${userMessageText}"
    `.trim();

    const modelResult = await generativeModel.generateContent(finalPrompt);
    const modelResponse = await modelResult.response;
    const modelText = modelResponse.text();
    console.log(`[CÂMERA 5] Resposta final da IA Concierge: "${modelText.substring(0, 100)}..."`); // CÂMERA DE SEGURANÇA

    const photoLinks = parceiros ? parceiros.flatMap(p => p.link_fotos || []) : [];

    // --- ETAPA F: Salvando a Conversa ---
    const { data: newInteraction, error: insertError } = await supabase.from('interacoes').insert({
      regiao_id: regiao.id,
      pergunta_usuario: userMessageText,
      resposta_ia: modelText,
      parceiros_sugeridos: parceiros || []
    }).select('id').single();

    if (insertError) {
      console.error("Erro ao salvar interação no Supabase:", insertError);
    }
    console.log("--- FIM DA INTERAÇÃO ---"); // CÂMERA DE SEGURANÇA

    // --- ETAPA G: Enviando a Resposta de Volta para o App ---
    return response.status(200).json({ 
      reply: modelText,
      interactionId: newInteraction?.id,
      photoLinks: photoLinks
    });

  } catch (error) {
    console.error("[/api/chat] Erro grave no servidor:", error);
    return response.status(500).json({ error: "Ocorreu um erro interno no cérebro do BEPIT." });
  }
});

// --- ROTA DO FEEDBACK ---
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
        return response.status(200).json({ success: true, message: "Feedback registrado!" });
    } catch (error) {
        console.error("[/api/feedback] Erro ao registrar feedback:", error);
        return response.status(500).json({ error: "Erro ao registrar feedback." });
    }
});

// --- PASSO FINAL: Ligando o Servidor ---
application.listen(serverPort, () => {
  console.log(`✅ 🤖 Cérebro OFICIAL do BEPIT Nexus (v1.5 - Raio-X) rodando na porta ${serverPort}`);
});

