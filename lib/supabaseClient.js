import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Credenciais do Supabase não encontradas. Verifique seu arquivo .env");
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);