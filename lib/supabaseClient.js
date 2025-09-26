// backend-oficial/lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) {
  throw new Error(
    "SUPABASE_URL ausente no .env do backend. Defina SUPABASE_URL com a URL do seu projeto Supabase."
  );
}
if (!serviceKey) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY ausente no .env do backend. Use a Service Role Key do Supabase (NÃO exponha no frontend)."
  );
}

export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false }
});