import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // pega ids por slug (sem precisar decorar id)
  const { data: regiao } = await supabase.from('regioes').select('id').eq('slug','regiao-dos-lagos').single();
  if (!regiao) throw new Error('Região dos Lagos não encontrada');

  const { data: cidade } = await supabase
    .from('cidades').select('id')
    .eq('regiao_id', regiao.id).eq('slug','cabo-frio').single();
  if (!cidade) throw new Error('Cidade cabo-frio não encontrada');

  const parceiro = {
    cidade_id: cidade.id,
    tipo: 'PARCEIRO',
    nome: 'Churrascaria do Mar',
    descricao: 'Carnes na brasa com vista para o mar',
    categoria: 'Churrascaria',
    beneficio_bepit: '10% de desconto no rodízio',
    endereco: 'Av. Atlântica, 1000 - Cabo Frio',
    contato: '(22) 99999-0000',
    tags: ['churrasco','carne','rodizio'],
    horario_funcionamento: 'Seg-Dom 11:30–23:00',
    faixa_preco: 'R$R$',
    fotos: ['https://picsum.photos/seed/churras/800/500'],
    ativo: true
  };

  const { error } = await supabase.from('parceiros').insert(parceiro);
  if (error) throw error;
  console.log('✓ Parceiro de teste criado.');
}
main().catch(e => { console.error(e); process.exit(1); });
