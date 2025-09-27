// backend-oficial/lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("[Supabase] Variáveis faltando: SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY.");
}

/**
 * IMPORTANTE:
 * - Este arquivo roda só no servidor (Node). Nunca bundle no frontend.
 * - Service Role ignora RLS por design. Use somente aqui.
 */
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
  global: { headers: {} }
});
