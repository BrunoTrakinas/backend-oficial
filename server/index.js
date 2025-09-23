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

    const prompt = `...SEU PROMPT COMPLETO AQUI...`.trim();

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