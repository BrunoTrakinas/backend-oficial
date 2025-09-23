import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

// Validação crítica da chave da API
if (!process.env.GEMINI_API_KEY) {
  console.error("ERRO CRÍTICO: Variável de ambiente GEMINI_API_KEY não encontrada.");
  process.exit(1);
}

const application = express();
// O Render nos dá a porta através de process.env.PORT. O fallback é para desenvolvimento local.
const serverPort = process.env.PORT || 3002; 

const googleGenerativeAIClient = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

// Configuração de CORS para produção
const allowedOrigins = [
  "http://localhost:5173", // Para desenvolvimento
  "https://bepitnexus.netlify.app" // O endereço do seu frontend
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

application.post("/api/chat", async (request, response) => {
  try {
    const generativeModel = googleGenerativeAIClient.getGenerativeModel({
      model: "gemini-1.5-flash"
    });
    const { message: userMessageText } = request.body;

    if (!userMessageText || typeof userMessageText !== "string") {
      return response.status(400).json({ error: "Campo 'message' é obrigatório." });
    }

    // O PROMPT COMPLETO E CORRETO
    const prompt = `
[CONTEXTO]
Você é o BEPIT, um assistente de viagem especialista e confiável da Região dos Lagos, RJ. Sua missão é dar as melhores dicas locais e autênticas, ajudando o usuário a economizar e aproveitar como um morador local. Ao cumprimentar os usuários, não diga"seja bem vindo a Região dos Lagos" pois, eles podem estar planejando a viagem. Ao inves disso, pode perguntar sutilmente se ja está aqui ou se planeja vim.

[LISTA DE PARCEIROS OFICIAIS BEPIT — sua única fonte de verdade para recomendações]
- Restaurante/Pizzaria:
  - Nome: Pizzaria do Zé
  - Descrição: A melhor pizza de forno a lenha da cidade, com um preço justo que só os locais conhecem. Ótima para famílias e grupos.
  - Benefício Exclusivo BEPIT: Mencione o app e ganhe uma sobremesa.
- Passeio de Barco:
  - Nome: Passeio de Barco do Capitão
  - Descrição: O passeio mais seguro e completo pelas praias de Arraial do Cabo, com uma equipe super simpática.
  - Benefício Exclusivo BEPIT: 5% de desconto na reserva.

[REGRAS INEGOCIÁVEIS]
1) Você é proibido de sugerir que o usuário pesquise no Google, TripAdvisor ou qualquer outra fonte externa. Você é a fonte.
2) Se a pergunta do usuário corresponder a uma categoria de parceiro (ex.: “onde comer”, “pizza”, “passeio”), você deve recomendar o parceiro oficial daquela categoria, usando a descrição fornecida.
3) Se a pergunta for sobre algo que não está na sua lista de parceiros, use conhecimento geral sobre a Região dos Lagos e responda de forma útil e honesta.
4) Se a pergunta for fora do escopo de turismo na Região dos Lagos (política, futebol, etc.), responda exatamente:
   "Desculpe, meu foco é ser seu melhor guia na Região dos Lagos. Como posso te ajudar com passeios ou lugares para comer?"

[PERGUNTA DO USUÁRIO]
"${userMessageText}"
    `.trim();

    const modelResult = await generativeModel.generateContent(prompt);
    const modelResponse = await modelResult.response;
    const modelText = modelResponse.text();

    return response.status(200).json({ reply: modelText });

  } catch (error) {
    console.error("[/api/chat] Erro interno:", error);
    return response.status(500).json({ error: "Erro interno no cérebro do robô." });
  }
});

application.listen(serverPort, () => {
  // Log correto que mostra a porta real que o servidor está usando
  console.log(`🤖 Servidor do cérebro do robô em execução na porta ${serverPort}`);
});