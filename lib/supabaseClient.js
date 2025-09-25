// F:\uber-chat-mvp\backend-oficial\lib\supabaseClient.js
import dotenv from "dotenv";
dotenv.config(); // carrega o .env ANTES de ler process.env

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // backend ONLY

if (!supabaseUrl) {
  throw new Error("Variável SUPABASE_URL não definida. Verifique seu .env.");
}
if (!supabaseServiceKey) {
  throw new Error("Variável SUPABASE_SERVICE_ROLE_KEY não definida. Verifique seu .env.");
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});