// F:\uber-chat-mvp\backend-oficial\lib\supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;

// No backend, é seguro usar a SERVICE ROLE (o servidor não é exposto ao público).
// Se não existir, cai para a ANON (precisa de RLS permitindo as tabelas usadas).
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

const keyParaUsar = serviceKey || anonKey;

if (!url || !keyParaUsar) {
  console.error("[Supabase] Faltam variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY/ANON_KEY no .env");
}

export const supabase = createClient(url, keyParaUsar, {
  auth: { persistSession: false },
  global: { headers: {} }
});
