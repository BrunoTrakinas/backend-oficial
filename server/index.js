// ===================================================================================
// ARQUIVO PRINCIPAL DO SERVIDOR (O "CÉREBRO" DO BEPIT)
// ===================================================================================

// --- PASSO 1: Importando nossas ferramentas ---
// Aqui, a gente "puxa" as caixas de ferramentas que vamos precisar para o trabalho.
import express from "express"; // O esqueleto do nosso servidor, cuida das rotas (URLs).
import cors from "cors"; // O "porteiro" que diz quais sites podem conversar com nosso servidor.
import { GoogleGenerativeAI } from "@google/generative-ai"; // A ferramenta para conectar com a IA do Google.
import dotenv from "dotenv"; // Para carregar nossas senhas e chaves secretas.
import { supabase } from "../lib/supabaseClient.js"; // A ferramenta para conectar com nosso banco de dados.

// --- PASSO 2: Carregando as chaves secretas ---
dotenv.config();

// Verificação de segurança: Se as chaves secretas não existirem, o servidor desliga.
// É melhor ele não ligar do que ligar com defeito e inseguro.
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
const serverPort = process.env.PORT || 3002; // Usa a porta do Render, ou a 3002 se estivermos testando local.

// Criamos a conexão oficial com a IA do Google.
const googleGenerativeAIClient = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

// --- PASSO 4: Configurando o "Porteiro" (CORS) ---
// Lista dos "amigos" que têm permissão para falar com nosso servidor.
// !! IMPORTANTE !! Se um dia você criar um novo site ou domínio, precisa adicionar o endereço dele aqui.
const allowedOrigins = [
  "http://localhost:5173",       // Para testes no seu computador
  "https://bepitnexus.netlify.app" // O endereço oficial do nosso app
];
const crossOriginResourceSharingOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true); // Se a origem for da lista, pode entrar!
    } else {
      callback(new Error('Acesso negado pelo CORS!')); // Se não for da lista, bloqueia.
    }
  }
};

application.use(cors(crossOriginResourceSharingOptions)); // Avisa o Express para usar nosso "porteiro".
application.options("*", cors(crossOriginResourceSharingOptions));
application.use(express.json()); // Permite que o servidor entenda o formato JSON, que é como os dados chegam.

// --- ROTA DE TESTE: O "batimento cardíaco" do servidor ---
// Se você acessar seudominio.com/health, ele responde que está vivo.
application.get("/health", (request, response) => {
  response.status(200).json({ ok: true, message: "Servidor BEPIT está online." });
});


// ===================================================================================
// ROTA PRINCIPAL DO CHAT (O CORAÇÃO DA OPERAÇÃO)
// ===================================================================================
application.post("/api/chat/:slugDaRegiao", async (request, response) => {
  try {
    // --- ETAPA A: Entendendo o pedido ---
    const { slugDaRegiao } = request.params; // Pega o "apelido" da região da URL (ex: 'regiao-dos-lagos').
    const { message: userMessageText } = request.body; // Pega a mensagem do usuário que veio do app.

    // Validação básica para garantir que a mensagem não está vazia.
    if (!userMessageText || typeof userMessageText !== "string") {
      return response.status(400).json({ error: "O campo 'message' é obrigatório." });
    }
    
    // Busca no banco de dados qual é a região baseada no "apelido".
    const { data: regiao, error: regiaoError } = await supabase.from('regioes').select('id, nome_regiao').eq('slug', slugDaRegiao).single();
    if (regiaoError || !regiao) {
      throw new Error(`Região com apelido '${slugDaRegiao}' não encontrada no banco de dados.`);
    }

    const generativeModel = googleGenerativeAIClient.getGenerativeModel({ model: "gemini-1.5-flash" });

    // --- ETAPA B: Virando um "Detetive" de Palavras-Chave ---
    // Pede para a IA extrair as palavras mais importantes da pergunta do usuário.
    const keywordExtractionPrompt = `Sua única tarefa é extrair até 3 palavras-chave de busca (tags) da frase do usuário abaixo, relacionadas a turismo. Responda APENAS com as palavras separadas por vírgula, em minúsculas, sem nenhuma outra frase ou explicação. Se não encontrar nenhuma tag, responda com a palavra "geral". Exemplo: "onde comer uma pizza boa?" -> "pizza, restaurante, comer". Frase: "${userMessageText}"`;
    
    const keywordResult = await generativeModel.generateContent(keywordExtractionPrompt);
    const keywordsText = (await keywordResult.response.text()).trim();
    const firstLineOfKeywords = keywordsText.split('\n')[0];
    const keywords = firstLineOfKeywords.split(',').map(kw => kw.trim().toLowerCase());

    // Truque para buscar tanto no singular quanto no plural (ex: restaurante, restaurantes)
    const searchKeywords = [...keywords];
    keywords.forEach(kw => {
        if (kw.endsWith('s')) {
            searchKeywords.push(kw.slice(0, -1));
        }
    });
    
    // --- ETAPA C: "Pescando" Parceiros no Banco de Dados ---
    // Agora, com as palavras-chave, buscamos no Supabase por parceiros que combinem.
    const { data: parceiros, error } = await supabase
      .from('parceiros')
      .select('nome, categoria, descricao, beneficio_bepit, endereco, faixa_preco, contato_telefone, link_fotos')
      .eq('regiao_id', regiao.id) // Filtra para pegar parceiros SÓ da região certa.
      .or(`tags.cs.{${searchKeywords.join(',')}},categoria.ilike.%${searchKeywords[0]}%`); // Procura nas 'tags' OU na 'categoria'.

    if (error) {
        console.error("Erro ao buscar parceiros no Supabase:", error);
        throw new Error("Falha ao consultar o banco de dados de parceiros.");
    }

    // --- ETAPA D: Montando o "Dossiê" para a IA ---
    // Prepara um texto com as informações dos parceiros encontrados.
    let parceirosContexto = "Nenhum parceiro específico encontrado.";
    if (parceiros && parceiros.length > 0) {
      parceirosContexto = "Parceiros Encontrados:\n" + parceiros.map(p => 
        `- Nome: ${p.nome}\n  - Descrição: ${p.descricao}\n  - Endereço: ${p.endereco}\n  - Benefício Exclusivo BEPIT: ${p.beneficio_bepit}`
      ).join('\n\n');
    }

    // --- ETAPA E: Dando as Ordens Finais para a IA (O Prompt) ---
    // Este é o nosso super prompt, as "Regras de Ouro" que a IA deve seguir.
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

    // Envia o prompt final para a IA e aguarda a resposta.
    const modelResult = await generativeModel.generateContent(finalPrompt);
    const modelResponse = await modelResult.response;
    const modelText = modelResponse.text();

    const photoLinks = parceiros ? parceiros.flatMap(p => p.link_fotos || []) : [];

    // --- ETAPA F: Salvando a Conversa para Análise Futura ---
    // Registra a interação no nosso banco de dados.
    const { data: newInteraction, error: insertError } = await supabase.from('interacoes').insert({
      regiao_id: regiao.id,
      pergunta_usuario: userMessageText,
      resposta_ia: modelText,
      parceiros_sugeridos: parceiros || []
    }).select('id').single();

    if (insertError) {
      console.error("Erro ao salvar interação no Supabase:", insertError);
    }

    // --- ETAPA G: Enviando a Resposta de Volta para o App ---
    return response.status(200).json({ 
      reply: modelText,
      interactionId: newInteraction?.id,
      photoLinks: photoLinks
    });

  } catch (error) {
    // Se qualquer coisa der errado no meio do caminho, essa "rede de segurança" captura o erro.
    console.error("[/api/chat] Erro grave no servidor:", error);
    return response.status(500).json({ error: "Ocorreu um erro interno no cérebro do BEPIT." });
  }
});


// --- ROTA DO FEEDBACK (LIKE / DISLIKE) ---
application.post("/api/feedback", async (request, response) => {
    try {
        const { interactionId, feedback } = request.body;
        if (!interactionId || !feedback) {
            return response.status(400).json({ error: "ID da interação e feedback são obrigatórios." });
        }
        // Atualiza a linha da interação com o feedback do usuário.
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
  // Essa mensagem só aparece no console do Render quando tudo deu certo.
  console.log(`✅ 🤖 Cérebro OFICIAL do BEPIT Nexus (v1.4 - Blindado) rodando na porta ${serverPort}`);
});