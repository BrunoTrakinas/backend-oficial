import 'dotenv/config';

console.log('CWD:', process.cwd());
console.log('SUPABASE_URL:', process.env.SUPABASE_URL || '(vazio)');
console.log('SERVICE LEN:', (process.env.SUPABASE_SERVICE_ROLE_KEY || '').length);
console.log('GEMINI LEN:', (process.env.GEMINI_API_KEY || '').length);
