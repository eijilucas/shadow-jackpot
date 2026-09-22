// Puxa as etiquetas da conta Melhor Envio e guarda em melhor_envio_shipments
// — o Melhor Envio não tem campo de referência externa (não dá pra saber
// sozinho qual pedido Shopify é cada etiqueta), então logo depois de
// importar, tenta casar cada pedido pendente com sua etiqueta por CEP
// exato + comprada em até 10 dias depois da venda; só confirma quando o
// cruzamento dá exatamente 1 candidato. Confirmado, o preço vai pra
// order_shipping.cost — é isso que a view sale_margin usa como
// shipping_cost. Pedido cujo CEP não bate com nenhuma etiqueta (ou bate
// com mais de uma) fica pendente pra conferência manual no admin.
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

// Pára ao achar uma página inteira já conhecida — a lista vem ordenada do
// mais recente pro mais antigo, então isso é seguro DEPOIS que o backfill
// completo já rodou uma vez até o fim de verdade (não travado no
// MAX_PAGES): daí em diante só aparece coisa nova no topo, o resto do
// histórico nunca muda. Sem isso, rodando de 6 em 6 horas pra sempre, cada
// execução reprocessaria o histórico inteiro (cresce sem parar) — caro e
// cada vez mais lento.
async function importShipments(supabase: SupabaseClient): Promise<{ processadas: number; paginas: number }> {
  const { data: existing, error: existingError } = await supabase.from("melhor_envio_shipments").select("melhor_envio_id");
  if (existingError) throw existingError;
  const knownIds = new Set((existing ?? []).map((r) => r.melhor_envio_id as string));

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

    if (result.data.every((o) => knownIds.has(o.id))) break;
    if (page >= result.last_page) break;
  }

  return { processadas, paginas: page };
}

interface OrderCandidate {
  shopify_order_id: number;
  recipient_zipcode: string;
  sale_date: string;
}

interface ShipmentCandidate {
  id: string;
  recipient_zipcode: string;
  price: number | null;
  shipment_date: string;
}

const MATCH_WINDOW_DAYS = 10;
const daysBetween = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

// Casa etiqueta com pedido por CEP exato + comprada em até
// MATCH_WINDOW_DAYS depois da venda — só confirma quando o cruzamento dá
// EXATAMENTE 1 candidato (ambíguo fica pra conferência manual no admin).
// Mesma regra usada no backfill manual (verificado contra ~50 pedidos
// reais antes de virar código).
async function matchShipments(supabase: SupabaseClient): Promise<{ casadas: number }> {
  const { data: pendingOrders, error: ordersError } = await supabase
    .from("order_shipping")
    .select("shopify_order_id, recipient_zipcode")
    .is("cost", null)
    .not("recipient_zipcode", "is", null);
  if (ordersError) throw ordersError;
  if (!pendingOrders || pendingOrders.length === 0) return { casadas: 0 };

  const orderIds = pendingOrders.map((o) => o.shopify_order_id);
  const { data: saleRows, error: saleError } = await supabase
    .from("sale_revenue")
    .select("shopify_order_id, sale_date")
    .in("shopify_order_id", orderIds);
  if (saleError) throw saleError;

  const earliestSaleDate = new Map<number, string>();
  for (const r of saleRows ?? []) {
    const current = earliestSaleDate.get(r.shopify_order_id);
    if (!current || r.sale_date < current) earliestSaleDate.set(r.shopify_order_id, r.sale_date);
  }

  const orders: OrderCandidate[] = pendingOrders
    .map((o) => ({
      shopify_order_id: o.shopify_order_id,
      recipient_zipcode: o.recipient_zipcode as string,
      sale_date: earliestSaleDate.get(o.shopify_order_id) ?? "",
    }))
    .filter((o) => o.sale_date);

  const { data: shipments, error: shipError } = await supabase
    .from("melhor_envio_shipments")
    .select("id, recipient_zipcode, price, shipment_date")
    .is("matched_shopify_order_id", null)
    .not("shipment_date", "is", null)
    .not("recipient_zipcode", "is", null)
    .returns<ShipmentCandidate[]>();
  if (shipError) throw shipError;

  let casadas = 0;
  const now = new Date().toISOString();
  for (const order of orders) {
    const candidates = (shipments ?? []).filter(
      (s) =>
        s.recipient_zipcode === order.recipient_zipcode &&
        new Date(s.shipment_date) >= new Date(order.sale_date) &&
        daysBetween(s.shipment_date, order.sale_date) <= MATCH_WINDOW_DAYS,
    );
    if (candidates.length !== 1) continue;
    const shipment = candidates[0];

    const { error: updateOrderError } = await supabase
      .from("order_shipping")
      .update({ cost: shipment.price, cost_synced_at: now })
      .eq("shopify_order_id", order.shopify_order_id);
    if (updateOrderError) throw updateOrderError;

    const { error: updateShipmentError } = await supabase
      .from("melhor_envio_shipments")
      .update({ matched_shopify_order_id: order.shopify_order_id, matched_at: now })
      .eq("id", shipment.id);
    if (updateShipmentError) throw updateShipmentError;

    // Tira da lista em memória pra não casar a mesma etiqueta duas vezes
    // com pedidos diferentes na mesma execução.
    const idx = shipments!.indexOf(shipment);
    if (idx >= 0) shipments!.splice(idx, 1);

    casadas++;
  }

  return { casadas };
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
    const { casadas } = await matchShipments(supabase);
    return new Response(
      JSON.stringify({ ok: true, etiquetas_processadas: processadas, paginas_lidas: paginas, etiquetas_casadas: casadas }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
