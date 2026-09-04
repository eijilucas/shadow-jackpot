import { supabase } from "./supabase";

export interface SaleMarginRow {
  sale_id: string;
  product_sku: string | null;
  product_name: string;
  quantity: number;
  gross_amount: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  net_profit: number;
  sale_date: string;
  piece_name: string;
  has_coupon: boolean;
  payment_method: "pix" | "cartao";
}

export interface MonthlyDreRow {
  month: string;
  gross_revenue: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  net_profit: number;
}

export interface OverheadRow {
  id: string;
  month: string;
  category: string;
  amount: number;
  is_marketing: boolean;
  allocation_method: "per_unit" | "per_revenue";
}

export interface FeeRatesRow {
  id: number;
  taxa_shopify_pct: number;
  taxa_gateway_cartao_pct: number;
  taxa_gateway_pix_pct: number;
  taxa_gateway_pix_fixo: number;
  imposto_pct: number;
  comissao_influencer_pct: number;
  desconto_medio_pct: number;
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
  // — não é peça de roupa, não faz sentido no ranking de margem por
  // peça, mesmo que a venda em si continue registrada.
  const excluded = [/gift\s*card/i];

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
    .select("id, month, category, amount, is_marketing, allocation_method")
    .eq("month", month)
    .order("is_marketing", { ascending: false })
    .returns<OverheadRow[]>();
  if (error) throw error;
  return data ?? [];
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
}) {
  const { data, error } = await db()
    .from("monthly_overhead")
    .insert({ ...row, month: row.month ?? currentMonthStart() })
    .select("id, month, category, amount, is_marketing, allocation_method")
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
    .select("id, sku, product_name, tecido, estampa, costura, outros_acabamentos, collection, collection_published_at, preco_venda")
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
