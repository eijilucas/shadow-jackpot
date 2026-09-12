// Traz pedidos históricos da loja pra `sale_revenue` — serve pra
// preencher o histórico com pedidos que já existiam ANTES do
// shopify-webhook começar a capturar sozinho, ou pra reprocessar um
// período (ex: depois de mudar a lógica de detecção de forma de
// pagamento). Reaplica a mesma lógica de custo/reembolso do webhook
// (idempotente por shopify_order_id + shopify_line_item_id, então rodar
// de novo não duplica nada).
//
// Não é um webhook — é disparada manualmente, com um POST protegido por
// secret próprio (reusa o mesmo ADMIN_IMPORT_SECRET do
// shopify-import-products).
//
// Deploy:
//   npx supabase functions deploy shopify-import-orders --project-ref <ref>
//
// Disparar (traz pedidos desde a data informada):
//   curl -X POST https://<ref>.supabase.co/functions/v1/shopify-import-orders \
//     -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>" \
//     -H "Content-Type: application/json" \
//     -d '{"since": "2026-08-01T00:00:00-03:00"}'

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_IMPORT_SECRET = Deno.env.get("ADMIN_IMPORT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPIFY_API_VERSION = "2025-01";
const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN") ?? "";
const SHOPIFY_CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";

// Pedidos com esses financial_status contam como venda (mesmo que
// parcial ou já reembolsada — o valor final já sai ajustado abaixo).
// "pending" e "voided" ficam de fora (nunca foi pago de verdade).
const COUNTABLE_FINANCIAL_STATUS = new Set(["paid", "partially_paid", "partially_refunded", "refunded"]);

interface ShopifyLineItem {
  id: number;
  product_id: number | null;
  sku: string | null;
  title: string;
  variant_title?: string | null;
  name?: string;
  quantity: number;
  price: string;
  total_discount?: string | null;
  discount_allocations?: { amount: string }[];
}

interface ShopifyRefundLineItem {
  line_item_id: number;
  quantity: number;
  line_item?: { price: string };
}

interface ShopifyRefund {
  refund_line_items: ShopifyRefundLineItem[];
}

interface ShopifyDiscountCode {
  code: string;
}

interface ShopifyOrder {
  id: number;
  order_number?: number;
  processed_at?: string;
  created_at: string;
  cancelled_at: string | null;
  financial_status: string;
  line_items: ShopifyLineItem[];
  refunds: ShopifyRefund[];
  discount_codes?: ShopifyDiscountCode[];
  payment_gateway_names?: string[];
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  shipping_lines?: { price?: string }[];
}

// Frete cobrado do cliente no checkout.
function shippingRevenue(order: ShopifyOrder): number {
  const fromSet = Number(order.total_shipping_price_set?.shop_money?.amount);
  if (Number.isFinite(fromSet)) return fromSet;
  return (order.shipping_lines ?? []).reduce((sum, l) => sum + (Number(l.price) || 0), 0);
}

interface SaleRow {
  shopify_order_id: number;
  shopify_line_item_id: number;
  shopify_product_id: number;
  product_sku: string | null;
  product_name: string;
  quantity: number;
  gross_amount: number;
  discount_amount: number;
  sale_date: string;
  has_coupon: boolean;
  payment_method: "pix" | "cartao";
}

// Desconto real do item: `price` da Shopify é sempre o preço de tabela, o
// cupom entra à parte. Cupom aplicado no pedido inteiro chega rateado em
// discount_allocations; desconto direto na linha vem em total_discount.
// Os dois juntos nunca aparecem preenchidos pro mesmo desconto, então
// preferimos o rateio quando existe pra não contar duas vezes.
function lineDiscount(item: ShopifyLineItem): number {
  const allocated = (item.discount_allocations ?? []).reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  if (allocated > 0) return allocated;
  return Number(item.total_discount) || 0;
}

// Qualquer gateway com "pix" no nome (o app que processa Pix varia por
// loja) — o resto (cartão, boleto etc.) cai como "cartao".
function detectPaymentMethod(order: ShopifyOrder): "pix" | "cartao" {
  const names = order.payment_gateway_names ?? [];
  return names.some((n) => /pix/i.test(n)) ? "pix" : "cartao";
}

function extractNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextPart = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  if (!nextPart) return null;
  const match = nextPart.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function fetchAccessToken(): Promise<string> {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Shopify (${SHOPIFY_STORE_DOMAIN}) respondeu ${res.status} ao gerar token de acesso`);
  const data = await res.json();
  return data.access_token as string;
}

async function fetchOrdersSince(accessToken: string, since: string): Promise<ShopifyOrder[]> {
  const orders: ShopifyOrder[] = [];
  let url: string | null =
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(since)}&limit=250`;

  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!res.ok) throw new Error(`Shopify (${SHOPIFY_STORE_DOMAIN}) respondeu ${res.status} ao listar pedidos`);
    const data = await res.json();
    orders.push(...(data.orders ?? []));
    url = extractNextUrl(res.headers.get("Link"));
  }

  return orders;
}

// Monta a linha de venda por item já com qualquer reembolso parcial
// aplicado (mesmo ajuste que o webhook faria em duas etapas — aqui dá
// pra fazer de uma vez só, já que o pedido inteiro está disponível).
function buildSaleRows(order: ShopifyOrder): SaleRow[] {
  const refundedByLineItem = new Map<number, { quantity: number; amount: number }>();
  for (const refund of order.refunds ?? []) {
    for (const item of refund.refund_line_items ?? []) {
      const unitPrice = Number(item.line_item?.price ?? 0);
      const entry = refundedByLineItem.get(item.line_item_id) ?? { quantity: 0, amount: 0 };
      entry.quantity += item.quantity;
      entry.amount += unitPrice * item.quantity;
      refundedByLineItem.set(item.line_item_id, entry);
    }
  }

  const hasCoupon = (order.discount_codes?.length ?? 0) > 0;
  const paymentMethod = detectPaymentMethod(order);

  return (order.line_items ?? [])
    .filter((item) => !!item.product_id)
    .map((item) => {
      const refunded = refundedByLineItem.get(item.id);
      const quantity = Math.max(0, item.quantity - (refunded?.quantity ?? 0));
      const gross_amount = Math.max(0, Number(item.price) * item.quantity - (refunded?.amount ?? 0));
      // Desconto acompanha as unidades que sobraram depois do reembolso.
      const discount_amount = item.quantity > 0
        ? Number((lineDiscount(item) * (quantity / item.quantity)).toFixed(2))
        : 0;
      return {
        shopify_order_id: order.id,
        shopify_line_item_id: item.id,
        shopify_product_id: item.product_id as number,
        product_sku: item.sku,
        product_name: item.variant_title ? `${item.title} - ${item.variant_title}` : (item.title ?? item.name ?? "Sem nome"),
        quantity,
        gross_amount,
        discount_amount,
        sale_date: order.processed_at ?? order.created_at,
        has_coupon: hasCoupon,
        payment_method: paymentMethod,
      };
    })
    .filter((row) => row.quantity > 0);
}

// Produtos que nunca são peça de roupa de verdade — a venda continua
// sendo registrada normalmente, só não ganham uma linha de custo
// automática.
const EXCLUDED_NAME_PATTERNS = [/gift\s*card/i];

async function ensureProductCostStubs(
  supabase: SupabaseClient,
  saleRows: { shopify_product_id: number; product_sku: string | null; product_name: string }[],
) {
  const eligible = saleRows.filter((r) => !EXCLUDED_NAME_PATTERNS.some((re) => re.test(r.product_name)));
  const uniqueByProduct = new Map(eligible.map((r) => [r.shopify_product_id, { sku: r.product_sku, product_name: r.product_name }]));
  const stubs = Array.from(uniqueByProduct, ([shopify_product_id, { sku, product_name }]) => ({
    shopify_product_id,
    sku,
    product_name,
    tecido: 0,
    estampa: 0,
    costura: 0,
    outros_acabamentos: 0,
  }));

  const { error } = await supabase
    .from("product_costs")
    .upsert(stubs, { onConflict: "shopify_product_id", ignoreDuplicates: true });
  if (error) throw error;
}

async function importOrders(supabase: SupabaseClient, since: string): Promise<number> {
  const accessToken = await fetchAccessToken();
  const orders = await fetchOrdersSince(accessToken, since);

  const rows: SaleRow[] = [];
  const shipRows: Record<string, unknown>[] = [];
  for (const order of orders) {
    if (order.cancelled_at) continue;
    if (!COUNTABLE_FINANCIAL_STATUS.has(order.financial_status)) continue;
    const saleRows = buildSaleRows(order);
    if (saleRows.length === 0) continue;
    rows.push(...saleRows);
    shipRows.push({
      shopify_order_id: order.id,
      order_number: order.order_number != null ? String(order.order_number) : null,
      revenue: shippingRevenue(order),
      revenue_synced_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return 0;

  const { error } = await supabase
    .from("sale_revenue")
    .upsert(rows, { onConflict: "shopify_order_id,shopify_line_item_id" });
  if (error) throw error;

  // Frete cobrado — `cost` fica por conta do shipping-cost-callback.
  const { error: shipError } = await supabase
    .from("order_shipping")
    .upsert(shipRows, { onConflict: "shopify_order_id" });
  if (shipError) throw shipError;

  await ensureProductCostStubs(supabase, rows);

  return rows.length;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!ADMIN_IMPORT_SECRET || !timingSafeEqual(authHeader, `Bearer ${ADMIN_IMPORT_SECRET}`)) {
    return new Response("Não autorizado", { status: 401 });
  }

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    return new Response("Loja Shopify não configurada", { status: 500 });
  }

  let since = "";
  try {
    const body = await req.json();
    since = body?.since ?? "";
  } catch {
    // corpo vazio é ok se "since" não for enviado — vira erro abaixo
  }
  if (!since) {
    return new Response('Informe {"since": "AAAA-MM-DDTHH:mm:ss-03:00"} no corpo do POST', { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const itens_importados = await importOrders(supabase, since);
    return new Response(JSON.stringify({ ok: true, itens_importados }), {
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
