// Puxa as etiquetas da conta Melhor Envio e guarda em melhor_envio_shipments
// pra conferência manual no admin — o Melhor Envio não tem campo de
// referência externa (não dá pra saber sozinho qual pedido Shopify é cada
// etiqueta), então cada uma chega "solta" e o admin liga na tela (por
// CEP/nome/data). Confirmado, o preço vai pra order_shipping.cost — é
// isso que a view sale_margin usa como shipping_cost.
//
// Por que polling e não webhook: o webhook do Melhor Envio só dispara pra
// etiqueta comprada PELO MESMO APP que registrou o webhook — como a loja
// compra a etiqueta direto pelo site deles, não por um app integrado, o
// webhook nunca dispararia. GET /me/orders lista tudo da conta, não
// importa por onde foi comprado.
//
// Auth: usa um token de aplicação de longa duração (gerado direto no
// painel do Melhor Envio, Integrações → Área do Desenvolvedor → seu app
// → Tokens — não é o token de OAuth de 30 dias, esse dura 1 ano). Não é
// um webhook — é disparada manualmente ou por um cron, com um POST
// protegido pelo mesmo ADMIN_IMPORT_SECRET dos imports da Shopify.
//
// Configuração:
//   npx supabase secrets set MELHORENVIO_TOKEN=<token do painel> --project-ref <ref>
//   (reusa ADMIN_IMPORT_SECRET, que já deve existir)
//
// Deploy — o --no-verify-jwt é obrigatório: a auth aqui é o Bearer do
// ADMIN_IMPORT_SECRET, não um JWT do Supabase.
//   npx supabase functions deploy melhor-envio-import-shipments --no-verify-jwt --project-ref <ref>
//
// Disparar (varre as N páginas mais recentes; endpoint não tem filtro por
// data, então pára sozinha ao achar uma etiqueta que já está no banco):
//   curl -X POST https://<ref>.supabase.co/functions/v1/melhor-envio-import-shipments \
//     -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>"

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_IMPORT_SECRET = Deno.env.get("ADMIN_IMPORT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MELHORENVIO_TOKEN = Deno.env.get("MELHORENVIO_TOKEN") ?? "";
const BASE_URL = "https://melhorenvio.com.br";

// Nunca varre mais que isso numa chamada só — evita rodar pra sempre se o
// "já está no banco" nunca bater (ex: primeira importação, banco vazio).
const MAX_PAGES = 60;

interface MeOrder {
  id: string;
  protocol?: string;
  status: string;
  price?: number;
  tracking?: string;
  to?: { name?: string; address?: string; postal_code?: string; zipcode?: string };
  paid_at?: string | null;
  created_at?: string;
}

interface MeOrdersPage {
  current_page: number;
  last_page: number;
  data: MeOrder[];
}

async function fetchOrdersPage(page: number): Promise<MeOrdersPage> {
  const res = await fetch(`${BASE_URL}/api/v2/me/orders?page=${page}`, {
    headers: {
      Authorization: `Bearer ${MELHORENVIO_TOKEN}`,
      Accept: "application/json",
      "User-Agent": "Shadow Jackpot (lucas@hinfros.com.br)",
    },
  });
  if (!res.ok) throw new Error(`Melhor Envio respondeu ${res.status} ao listar etiquetas (página ${page})`);
  return await res.json();
}

// Sempre faz upsert de tudo que encontra, página por página — não tenta
// "parar cedo" ao achar algo já conhecido. A lista vem ordenada do mais
// recente pro mais antigo, mas uma rodada anterior pode ter batido no
// MAX_PAGES antes do fim de verdade, e a primeira página fica "toda
// conhecida" pra sempre depois da primeira importação; parar nela
// esconderia histórico mais antigo ainda não importado. upsert é
// idempotente — reprocessar o que já existe não tem custo real.
async function importShipments(supabase: SupabaseClient): Promise<{ processadas: number; paginas: number }> {
  let processadas = 0;
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const result = await fetchOrdersPage(page);
    if (result.data.length === 0) break;

    const rows = result.data.map((o) => ({
      melhor_envio_id: o.id,
      protocol: o.protocol ?? null,
      status: o.status,
      price: o.price ?? null,
      recipient_name: o.to?.name ?? null,
      recipient_zipcode: o.to?.postal_code ?? o.to?.zipcode ?? null,
      tracking_code: o.tracking ?? null,
      // paid_at é quando a etiqueta virou custo de verdade; created_at
      // como fallback pras que ainda não foram pagas.
      shipment_date: o.paid_at ?? o.created_at ?? null,
      event_received_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from("melhor_envio_shipments").upsert(rows, { onConflict: "melhor_envio_id" });
    if (error) throw error;
    processadas += rows.length;

    if (page >= result.last_page) break;
  }

  return { processadas, paginas: page };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Método não permitido", { status: 405 });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!ADMIN_IMPORT_SECRET || !timingSafeEqual(authHeader, `Bearer ${ADMIN_IMPORT_SECRET}`)) {
    return new Response("Não autorizado", { status: 401 });
  }
  if (!MELHORENVIO_TOKEN) {
    return new Response("Melhor Envio não configurado (falta o secret MELHORENVIO_TOKEN)", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { processadas, paginas } = await importShipments(supabase);
    return new Response(JSON.stringify({ ok: true, etiquetas_processadas: processadas, paginas_lidas: paginas }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
