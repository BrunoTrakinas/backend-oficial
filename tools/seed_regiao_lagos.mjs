// F:\uber-chat-mvp\backend-oficial\tools\seed_regiao_lagos.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltam SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function upsertRegiao(nome, slug) {
  // 1) tenta achar
  let { data: r, error } = await supabase
    .from('regioes')
    .select('id, nome, slug')
    .eq('slug', slug)
    .maybeSingle();

  if (error) throw error;

  // 2) cria se não existir
  if (!r) {
    const { data: criada, error: errIns } = await supabase
      .from('regioes')
      .insert({ nome, slug })
      .select('id, nome, slug')
      .single();
    if (errIns) throw errIns;
    r = criada;
    console.log('✓ Região criada:', r);
  } else {
    // garante nome atualizado
    const { data: atualizada, error: errUp } = await supabase
      .from('regioes')
      .update({ nome })
      .eq('id', r.id)
      .select('id, nome, slug')
      .single();
    if (!errUp && atualizada) r = atualizada;
    console.log('✓ Região existente/atualizada:', r);
  }
  return r.id;
}

async function ensureCidade(regiao_id, nome, slug) {
  // verifica se existe por (regiao_id, slug)
  let { data: c, error } = await supabase
    .from('cidades')
    .select('id, regiao_id, nome, slug')
    .eq('regiao_id', regiao_id)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;

  if (!c) {
    const { data: criada, error: errIns } = await supabase
      .from('cidades')
      .insert({ regiao_id, nome, slug })
      .select('id, regiao_id, nome, slug')
      .single();
    if (errIns) throw errIns;
    console.log('  ✓ Cidade criada:', criada);
    return criada.id;
  } else {
    // mantém nome atualizado
    const { data: atualizada, error: errUp } = await supabase
      .from('cidades')
      .update({ nome })
      .eq('id', c.id)
      .select('id, regiao_id, nome, slug')
      .single();
    if (!errUp && atualizada) c = atualizada;
    console.log('  ✓ Cidade existente/atualizada:', c);
    return c.id;
  }
}

async function main() {
  try {
    // Região dos Lagos
    const regiaoId = await upsertRegiao('Região dos Lagos', 'regiao-dos-lagos');

    // Cidades
    const cidades = [
      { nome: 'Cabo Frio',           slug: 'cabo-frio' },
      { nome: 'Arraial do Cabo',     slug: 'arraial-do-cabo' },
      { nome: 'Búzios',              slug: 'buzios' },
      { nome: 'São Pedro da Aldeia', slug: 'sao-pedro-da-aldeia' },
    ];

    for (const c of cidades) {
      await ensureCidade(regiaoId, c.nome, c.slug);
    }

    console.log('\n✓ Seed finalizado com sucesso.');
    process.exit(0);
  } catch (e) {
    console.error('Erro no seed:', e);
    process.exit(1);
  }
}

await main();
