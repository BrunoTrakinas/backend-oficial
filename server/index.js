import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Variável de ambiente GEMINI_API_KEY ausente. Defina-a no arquivo .env do servidor.");
  process.exit(1);
}

const application = express();
const serverPort = process.env.PORT || 3002;

const googleGenerativeArtificialIntelligenceClient = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

const crossOriginResourceSharingOptions = {
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://bepitnexus.netlify.app/"
  ],
  credentials: true,
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204
};

application.use(cors(crossOriginResourceSharingOptions));
application.options("*", cors(crossOriginResourceSharingOptions));
application.use(express.json());

application.get("/health", (request, response) => {
  response.status(200).json({
    ok: true,
    service: "bepit-robot-brain",
    port: serverPort,
    timestamp: new Date().toISOString()
  });
});

application.post("/api/chat", async (request, response) => {
  try {
    const userRequestBody = request.body || {};
    const userMessageText = userRequestBody.message;

    if (typeof userMessageText !== "string" || userMessageText.trim().length === 0) {
      return response
        .status(400)
        .json({ error: "Campo 'message' é obrigatório e deve ser uma string não vazia." });
    }

    const generativeModel = googleGenerativeArtificialIntelligenceClient.getGenerativeModel({
      model: "gemini-1.5-flash"
    });

    // Prompt único e bem formatado
    const prompt = `
[CONTEXTO]
Você é o BEPIT, um assistente de viagem especialista e confiável da Região dos Lagos, RJ. Sua missão é dar as melhores dicas locais e autênticas, ajudando o usuário a economizar e aproveitar como um morador local.

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
    const modelResponse = modelResult.response;
    const modelText = modelResponse.text();

    return response.status(200).json({ reply: modelText });
  } catch (error) {
    console.error("[/api/chat] Erro interno:", {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
      responseStatus: error?.response?.status,
      responseData: error?.response?.data
    });
    return response.status(500).json({ error: "Erro interno no cérebro do robô." });
  }
});

application.use((request, response) => {
  response.status(404).json({
    error: `Rota não encontrada: ${request.method} ${request.originalUrl}`
  });
});

application.listen(serverPort, () => {
  console.log(`🤖 Servidor do cérebro do robô em execução em http://localhost:10000`);
});
