import { supabase } from "./supabase";

export interface SaleMarginRow {
  sale_id: string;
  product_sku: string | null;
  product_name: string;
  quantity: number;
  // Líquido de cupom — a view já subtrai o desconto do preço de tabela.
  gross_amount: number;
  discount_amount: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  shipping_revenue: number;
  shipping_cost: number;
  shipping_adjustment: number;
  // false = a etiqueta desse pedido ainda não teve o custo empurrado pelo
  // sistema de etiquetas, então shipping_cost caiu no fallback estimado.
  has_real_shipping_cost: boolean;
  net_profit: number;
  sale_date: string;
  piece_name: string;
  has_coupon: boolean;
  payment_method: "pix" | "cartao";
}

export interface MonthlyDreRow {
  month: string;
  gross_revenue: number;
  discount_amount: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  shipping_revenue: number;
  shipping_cost: number;
  shipping_adjustment: number;
  net_profit: number;
}

export interface OverheadRow {
  id: string;
  month: string;
  category: string;
  amount: number;
  is_marketing: boolean;
  allocation_method: "per_unit" | "per_revenue";
  manually_edited: boolean;
  // Só vale pra marketing: ligado, a linha é herdada pelos meses seguintes
  // igual a um gasto fixo. Gasto fixo é sempre herdado, ignora esta flag.
  recorrente: boolean;
}

// Gasto que se repete no mês seguinte — fixo sempre, marketing só quando
// marcado. É o que decide se editar/apagar propaga pra frente.
export function isHerdavel(row: Pick<OverheadRow, "is_marketing" | "recorrente">): boolean {
  return !row.is_marketing || row.recorrente;
}

export interface FeeRatesRow {
  id: number;
  taxa_shopify_pct: number;
  taxa_gateway_cartao_pct: number;
  taxa_gateway_pix_pct: number;
  taxa_gateway_pix_fixo: number;
  taxa_antifraude_fixo: number;
  taxa_frete_estimado: number;
  imposto_pct: number;
  comissao_influencer_pct: number;
  sacolinha: number;
  adesivo: number;
}

export interface ProductCostRow {
  id: string;
  sku: string | null;
  product_name: string;
  tecido: number;
  estampa: number;
  costura: number;
  outros_acabamentos: number;
  fotolito: number;
  gravacao_tela: number;
  corte: number;
  collection: string | null;
  collection_published_at: string | null;
  preco_venda: number | null;
}

export function currentMonthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Um dia depois de `dateStr` — usado como limite superior EXCLUSIVO nas
// queries, pra "até 07/08" incluir o dia 7 inteiro (sale_date é
// timestamptz, então "< 07/08" cortaria as vendas do próprio dia 7).
function dayAfter(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Período anterior de mesma duração, terminando um dia antes de `start`
// — usado pra comparar "essa semana" com "a semana anterior", etc.
export function previousPeriod(start: string, end: string): { start: string; end: string } {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const days = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;
  const prevEnd = new Date(startDate.getTime() - msPerDay);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * msPerDay);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(prevStart), end: fmt(prevEnd) };
}

function db() {
  if (!supabase) throw new Error("Supabase não configurado");
  return supabase;
}

export async function fetchSaleMarginForRange(start: string, end: string) {
  const { data, error } = await db()
    .from("sale_margin")
    .select("*")
    .gte("sale_date", start)
    .lt("sale_date", dayAfter(end))
    .returns<SaleMarginRow[]>();
  if (error) throw error;
  return data ?? [];
}

export async function fetchSkuMarginForRange(start: string, end: string) {
  const rows = await fetchSaleMarginForRange(start, end);

  // Mesma exclusão aplicada na criação automática de custo (gift card)
  // — não é peça de roupa, não faz sentido no ranking de margem por peça,
  // mesmo que a venda em si continue registrada.
  const excluded = [/gift\s*card/i];

  // Lucro por peça é o lucro líquido de verdade: já vem da view com custo da
  // peça, taxas de venda, marketing e fixo rateados e o resultado do frete.
  // Chegou a ficar só como "faturamento − custo da peça" por um tempo, mas
  // aquilo dava margem de 80% e era lido como margem real — voltou a ser a
  // conta completa, a mesma que o Dashboard mostra.
  const bySku = new Map<string, { sku: string; units: number; grossAmount: number; netProfit: number }>();
  for (const row of rows) {
    if (excluded.some((re) => re.test(row.piece_name))) continue;
    const entry = bySku.get(row.piece_name) ?? { sku: row.piece_name, units: 0, grossAmount: 0, netProfit: 0 };
    entry.units += row.quantity;
    entry.grossAmount += row.gross_amount;
    entry.netProfit += row.net_profit;
    bySku.set(row.piece_name, entry);
  }
  return Array.from(bySku.values())
    .map((r) => ({
      sku: r.sku,
      units: r.units,
      netProfit: r.netProfit,
      profitPerUnit: r.units > 0 ? r.netProfit / r.units : 0,
      marginPct: r.grossAmount > 0 ? (r.netProfit / r.grossAmount) * 100 : 0,
    }))
    .sort((a, b) => b.marginPct - a.marginPct);
}

// Data da venda mais antiga que realmente existe na base — usada como
// limite inferior do calendário. A API da Shopify só devolve pedidos dos
// últimos 60 dias sem o escopo read_all_orders, então o histórico tem
// buracos (mês incompleto, ou mês inteiro faltando); sem esse limite o
// calendário deixa escolher uma data anterior ao que foi importado e o
// período volta vazio ou com faturamento sub-representado, sem aviso.
export async function fetchEarliestSaleDate() {
  const { data, error } = await db()
    .from("sale_revenue")
    .select("sale_date")
    .order("sale_date", { ascending: true })
    .limit(1)
    .maybeSingle<{ sale_date: string }>();
  if (error) throw error;
  return data?.sale_date ?? null;
}

export async function fetchLastSyncTime() {
  const { data, error } = await db()
    .from("sale_revenue")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ synced_at: string }>();
  if (error) throw error;
  return data?.synced_at ?? null;
}

export async function fetchMonthlyOverhead(month = currentMonthStart()) {
  const { data, error } = await db()
    .from("monthly_overhead")
    .select("id, month, category, amount, is_marketing, allocation_method, manually_edited, recorrente")
    .eq("month", month)
    .order("is_marketing", { ascending: false })
    .returns<OverheadRow[]>();
  if (error) throw error;
  return data ?? [];
}

// Materializa os gastos fixos herdados nos meses que ainda não têm.
// Idempotente — pode chamar sempre.
export async function carryForwardFixedOverhead() {
  const { error } = await db().rpc("carry_forward_fixed_overhead");
  if (error) throw error;
}

// Editou um gasto herdável num mês → propaga o valor novo pros meses
// seguintes que ainda não foram mexidos na mão. Meses anteriores ficam.
// `isMarketing` mantém os dois baldes separados: "Tráfego pago" de marketing
// não propaga em cima de um fixo de mesmo nome.
export async function propagateFixedOverheadAmount(
  category: string,
  fromMonth: string,
  amount: number,
  isMarketing = false,
) {
  const { error } = await db()
    .from("monthly_overhead")
    .update({ amount, updated_at: new Date().toISOString() })
    .eq("is_marketing", isMarketing)
    .eq("category", category)
    .eq("manually_edited", false)
    .gt("month", fromMonth);
  if (error) throw error;
}

export async function propagateFixedOverheadMethod(
  category: string,
  fromMonth: string,
  allocation_method: OverheadRow["allocation_method"],
  isMarketing = false,
) {
  const { error } = await db()
    .from("monthly_overhead")
    .update({ allocation_method, updated_at: new Date().toISOString() })
    .eq("is_marketing", isMarketing)
    .eq("category", category)
    .eq("manually_edited", false)
    .gt("month", fromMonth);
  if (error) throw error;
}

export async function markOverheadManuallyEdited(id: string) {
  const { error } = await db().from("monthly_overhead").update({ manually_edited: true }).eq("id", id);
  if (error) throw error;
}

// Apaga um gasto herdável desse mês pra frente (o passado fica no histórico).
export async function deleteFixedOverheadForward(category: string, fromMonth: string, isMarketing = false) {
  const { error } = await db()
    .from("monthly_overhead")
    .delete()
    .eq("is_marketing", isMarketing)
    .eq("category", category)
    .gte("month", fromMonth);
  if (error) throw error;
}

// Liga/desliga a repetição mensal de um gasto de marketing. Ligar propaga a
// marcação pros meses seguintes que herdarem; desligar só afeta daqui pra
// frente — mês já fechado não muda.
export async function updateOverheadRecorrente(id: string, recorrente: boolean) {
  const { error } = await db()
    .from("monthly_overhead")
    .update({ recorrente, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function updateOverheadAmount(id: string, amount: number) {
  const { error } = await db().from("monthly_overhead").update({ amount, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function updateOverheadMethod(id: string, allocation_method: OverheadRow["allocation_method"]) {
  const { error } = await db().from("monthly_overhead").update({ allocation_method, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function deleteOverhead(id: string) {
  const { error } = await db().from("monthly_overhead").delete().eq("id", id);
  if (error) throw error;
}

export async function insertOverhead(row: {
  category: string;
  amount: number;
  is_marketing: boolean;
  allocation_method: OverheadRow["allocation_method"];
  month?: string;
  recorrente?: boolean;
  // Marketing digitado na mão já é gasto realizado — nasce marcado, pra não
  // ser confundido com valor herdado e entrar rateado pelos dias do mês.
  manually_edited?: boolean;
}) {
  const { data, error } = await db()
    .from("monthly_overhead")
    .insert({ ...row, month: row.month ?? currentMonthStart() })
    .select("id, month, category, amount, is_marketing, allocation_method, manually_edited, recorrente")
    .single<OverheadRow>();
  if (error) throw error;
  return data;
}

export async function fetchFeeRates() {
  const { data, error } = await db().from("sale_fee_rates").select("*").eq("id", 1).single<FeeRatesRow>();
  if (error) throw error;
  return data;
}

export async function updateFeeRates(rates: Omit<FeeRatesRow, "id">) {
  const { error } = await db().from("sale_fee_rates").update({ ...rates, updated_at: new Date().toISOString() }).eq("id", 1);
  if (error) throw error;
}

export async function fetchProductCosts() {
  const { data, error } = await db()
    .from("product_costs")
    .select("id, sku, product_name, tecido, estampa, costura, outros_acabamentos, fotolito, gravacao_tela, corte, collection, collection_published_at, preco_venda")
    .order("product_name")
    .returns<ProductCostRow[]>();
  if (error) throw error;
  return data ?? [];
}

export async function updateProductCost(
  id: string,
  field: keyof Omit<ProductCostRow, "id" | "sku" | "product_name">,
  value: number,
) {
  const { error } = await db()
    .from("product_costs")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function updateProductName(id: string, product_name: string) {
  const { error } = await db()
    .from("product_costs")
    .update({ product_name, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function updateProductSku(id: string, newSku: string) {
  const { error } = await db()
    .from("product_costs")
    .update({ sku: newSku, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteProductCost(id: string) {
  const { error } = await db().from("product_costs").delete().eq("id", id);
  if (error) throw error;
}

export async function insertProductCost(row: Omit<ProductCostRow, "id">) {
  const { data, error } = await db().from("product_costs").insert(row).select().single<ProductCostRow>();
  if (error) throw error;
  return data;
}
