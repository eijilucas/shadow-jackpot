import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useSearchParams } from "react-router-dom";
import { TopBar, AdminBackLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
import { DateRangePicker } from "../components/DateRangePicker";
import { DreWaterfall, aggregateDre } from "../components/DreWaterfall";
import { supabase } from "../lib/supabase";
import {
  fetchMonthlyOverhead,
  updateOverheadAmount,
  updateOverheadMethod,
  deleteOverhead,
  insertOverhead,
  carryForwardFixedOverhead,
  isHerdavel,
  updateOverheadRecorrente,
  propagateFixedOverheadAmount,
  propagateFixedOverheadMethod,
  markOverheadManuallyEdited,
  deleteFixedOverheadForward,
  fetchFeeRates,
  updateFeeRates,
  fetchProductCosts,
  updateProductCost,
  updateProductName,
  deleteProductCost,
  insertProductCost,
  fetchSkuMarginForRange,
  fetchSaleMarginForRange,
  currentMonthStart,
  todayStr,
  type OverheadRow,
  type FeeRatesRow,
  type ProductCostRow,
  type SaleMarginRow,
} from "../lib/queries";

type Tab = "sku" | "fees" | "overhead" | "frete" | "profit" | "coupon" | "payment";
const TABS: Tab[] = ["sku", "fees", "overhead", "frete", "profit", "coupon", "payment"];
type PieceMargin = { sku: string; units: number; netProfit: number; profitPerUnit: number; marginPct: number };

function marginClass(pct: number) {
  if (pct >= 40) return "good";
  if (pct >= 15) return "mid";
  return "low";
}

function money(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}
// Campos de percentual usam toFixed(2), que gera "6.00" (ponto decimal,
// sem separador de milhar) — parseMoney interpretaria o ponto como
// separador de milhar e leria "600". Percentual nunca precisa de
// separador de milhar, então essa função só troca vírgula por ponto.
function parsePercent(value: string): number | null {
  const parsed = Number(value.replace("%", "").trim().replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}
function monthLabel(monthStr: string) {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
}
function dateLabelShort(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function rangeLabel(start: string, end: string) {
  return start === end ? dateLabelShort(start) : `${dateLabelShort(start)} a ${dateLabelShort(end)}`;
}
function shiftMonth(monthStr: string, delta: number) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function emptyProductCost(collection: string | null = null): Omit<ProductCostRow, "id"> {
  return {
    sku: null,
    product_name: "",
    tecido: 0,
    estampa: 0,
    costura: 0,
    outros_acabamentos: 0,
    collection,
    collection_published_at: null,
    preco_venda: null,
  };
}

function ProductPanel({
  title,
  products,
  newProduct,
  setNewProduct,
  onCostBlur,
  onNameBlur,
  onDelete,
  onAdd,
}: {
  title: string;
  products: ProductCostRow[];
  newProduct: Omit<ProductCostRow, "id">;
  setNewProduct: Dispatch<SetStateAction<Omit<ProductCostRow, "id">>>;
  onCostBlur: (id: string, field: keyof Omit<ProductCostRow, "id" | "sku" | "product_name">, value: string) => void;
  onNameBlur: (id: string, value: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
}) {
  const costFields = ["tecido", "estampa", "costura", "outros_acabamentos"] as const;
  const newTotal = costFields.reduce((sum, f) => sum + newProduct[f], 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          <div className="panel-hint">
            A soma das colunas é o quanto custa produzir a peça — é isso que sai da venda antes de qualquer outra coisa.
            Sacolinha e adesivo custam o mesmo pra toda peça, então ficaram na aba "Taxas de venda".
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              <th className="num">Tecido</th>
              <th className="num">Estampa</th>
              <th className="num">Costura</th>
              <th className="num">Outros</th>
              <th className="num">Total</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const total = p.tecido + p.estampa + p.costura + p.outros_acabamentos;
              return (
                <tr key={p.id}>
                  <td className="sku">
                    <input
                      className="cell-text"
                      defaultValue={p.product_name}
                      onBlur={(e) => onNameBlur(p.id, e.target.value)}
                      style={{ width: 220, display: "block" }}
                    />
                    {total === 0 && (
                      <span className="margin-pill low" style={{ marginTop: 6 }} title="Peça criada automaticamente pela primeira venda — falta preencher o custo">
                        custo zerado
                      </span>
                    )}
                  </td>
                  {costFields.map((field) => (
                    <td className="num" key={field}>
                      <input className="cell-input" defaultValue={money(p[field])} onBlur={(e) => onCostBlur(p.id, field, e.target.value)} />
                    </td>
                  ))}
                  <td className="num total-cell">{money(total)}</td>
                  <td>
                    <div className="icon-cell" onClick={() => onDelete(p.id)}>✕</div>
                  </td>
                </tr>
              );
            })}
            <tr>
              <td className="sku">
                <input
                  className="cell-text"
                  placeholder="Nome da peça"
                  style={{ width: 220 }}
                  value={newProduct.product_name}
                  onChange={(e) => setNewProduct((s) => ({ ...s, product_name: e.target.value }))}
                />
              </td>
              {costFields.map((field) => (
                <td className="num" key={field}>
                  <input
                    className="cell-input"
                    value={money(newProduct[field])}
                    onChange={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setNewProduct((s) => ({ ...s, [field]: v }));
                    }}
                  />
                </td>
              ))}
              <td className="num total-cell">{money(newTotal)}</td>
              <td>
                <div className="icon-cell" onClick={onAdd}>+</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PieceMarginTable({
  title,
  hint,
  rows,
  sort,
  onSort,
  emptyMessage,
  isCostMissing,
}: {
  title: string;
  hint: string;
  rows: PieceMargin[];
  sort: { field: keyof PieceMargin; dir: "asc" | "desc" };
  onSort: (field: keyof PieceMargin) => void;
  emptyMessage: string;
  isCostMissing: (pieceName: string) => boolean;
}) {
  const sorted = [...rows].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const field = sort.field;
    if (field === "sku") return a.sku.localeCompare(b.sku) * dir;
    return (a[field] - b[field]) * dir;
  });
  const arrow = (field: keyof PieceMargin) => (sort.field === field ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          <div className="panel-hint">{hint}</div>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => onSort("sku")}>Peça{arrow("sku")}</th>
              <th className="num sortable" onClick={() => onSort("units")}>Unid.{arrow("units")}</th>
              <th className="num sortable" onClick={() => onSort("netProfit")}>Lucro{arrow("netProfit")}</th>
              <th className="num sortable" onClick={() => onSort("profitPerUnit")}>Lucro/un.{arrow("profitPerUnit")}</th>
              <th className="num sortable" onClick={() => onSort("marginPct")}>Margem{arrow("marginPct")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: "var(--ink-faint)" }}>{emptyMessage}</td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.sku}>
                  <td className="sku">
                    {row.sku}
                    {isCostMissing(row.sku) && <span className="cost-missing">sem custo</span>}
                  </td>
                  <td className="num">{row.units}</td>
                  <td className="num">R$ {money(row.netProfit)}</td>
                  <td className="num">R$ {money(row.profitPerUnit)}</td>
                  <td className="num">
                    <span className={`margin-pill ${marginClass(row.marginPct)}`}>{row.marginPct.toFixed(1)}%</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Admin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = tabParam && (TABS as string[]).includes(tabParam) ? (tabParam as Tab) : "overhead";
  function setTab(next: Tab) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set("tab", next);
      return params;
    }, { replace: true });
  }
  const [overhead, setOverhead] = useState<OverheadRow[]>([]);
  const [feeRates, setFeeRates] = useState<FeeRatesRow | null>(null);
  const [productCosts, setProductCosts] = useState<ProductCostRow[]>([]);
  const [pieceMargin, setPieceMargin] = useState<PieceMargin[]>([]);
  const [pieceSearch, setPieceSearch] = useState("");
  const [pieceSort, setPieceSort] = useState<{ field: keyof PieceMargin; dir: "asc" | "desc" }>({ field: "marginPct", dir: "desc" });
  const [profitRangeStart, setProfitRangeStart] = useState(currentMonthStart());
  const [profitRangeEnd, setProfitRangeEnd] = useState(todayStr());
  const [couponRows, setCouponRows] = useState<SaleMarginRow[]>([]);
  const [overheadMonth, setOverheadMonth] = useState(currentMonthStart());
  const [newMarketing, setNewMarketing] = useState({ category: "", amount: "0,00", method: "per_revenue" as OverheadRow["allocation_method"], recorrente: false });
  const [newFixed, setNewFixed] = useState({ category: "", amount: "0,00", method: "per_unit" as OverheadRow["allocation_method"] });
  const [newProduct, setNewProduct] = useState<Omit<ProductCostRow, "id">>(() => emptyProductCost());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [feeSaved, setFeeSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [rates, costs] = await Promise.all([fetchFeeRates(), fetchProductCosts()]);
        if (cancelled) return;
        setFeeRates(rates);
        setProductCosts(costs);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erro ao carregar dados.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const carriedForwardRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!carriedForwardRef.current) {
        carriedForwardRef.current = true;
        try {
          await carryForwardFixedOverhead();
        } catch {
          // não fatal — se falhar, o mês só não herda os fixos automaticamente
        }
      }
      const rows = await fetchMonthlyOverhead(overheadMonth);
      if (!cancelled) setOverhead(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [overheadMonth]);

  useEffect(() => {
    let cancelled = false;
    fetchSkuMarginForRange(profitRangeStart, profitRangeEnd).then((rows) => {
      if (!cancelled) setPieceMargin(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [profitRangeStart, profitRangeEnd]);

  useEffect(() => {
    let cancelled = false;
    fetchSaleMarginForRange(profitRangeStart, profitRangeEnd).then((rows) => {
      if (!cancelled) setCouponRows(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [profitRangeStart, profitRangeEnd]);

  async function handleAmountBlur(id: string, value: string) {
    const parsed = parseMoney(value);
    if (parsed === null) return;
    const row = overhead.find((r) => r.id === id);
    const herdavel = row ? isHerdavel(row) : false;
    setOverhead((rows) => rows.map((r) => (r.id === id ? { ...r, amount: parsed, manually_edited: herdavel ? true : r.manually_edited } : r)));
    await updateOverheadAmount(id, parsed);
    // Gasto herdável: marca esse mês como mexido na mão e propaga o valor novo
    // pros meses seguintes que ainda estão herdando.
    if (row && herdavel) {
      await markOverheadManuallyEdited(id);
      await propagateFixedOverheadAmount(row.category, row.month, parsed, row.is_marketing);
    }
  }

  async function handleMethodChange(id: string, method: OverheadRow["allocation_method"]) {
    const row = overhead.find((r) => r.id === id);
    const herdavel = row ? isHerdavel(row) : false;
    setOverhead((rows) => rows.map((r) => (r.id === id ? { ...r, allocation_method: method, manually_edited: herdavel ? true : r.manually_edited } : r)));
    await updateOverheadMethod(id, method);
    if (row && herdavel) {
      await markOverheadManuallyEdited(id);
      await propagateFixedOverheadMethod(row.category, row.month, method, row.is_marketing);
    }
  }

  async function handleDeleteOverhead(id: string) {
    const row = overhead.find((r) => r.id === id);
    setOverhead((rows) => rows.filter((r) => r.id !== id));
    if (row && isHerdavel(row)) {
      // Gasto que se repete: apaga desse mês pra frente, o passado fica no
      // histórico. Marketing pontual some só do mês dele.
      await deleteFixedOverheadForward(row.category, row.month, row.is_marketing);
    } else {
      await deleteOverhead(id);
    }
  }

  async function handleAddMarketing() {
    const amount = parseMoney(newMarketing.amount) ?? 0;
    if (!newMarketing.category.trim()) return;
    const row = await insertOverhead({
      category: newMarketing.category.trim(),
      amount,
      is_marketing: true,
      allocation_method: newMarketing.method,
      month: overheadMonth,
      recorrente: newMarketing.recorrente,
      // Você digitou esse valor, então ele é o gasto do mês — não uma projeção
      // herdada. Sem isso o rateio trataria como estimativa e cortaria pelos
      // dias decorridos.
      manually_edited: true,
    });
    setOverhead((rows) => [...rows, row]);
    const repetia = newMarketing.recorrente;
    setNewMarketing({ category: "", amount: "0,00", method: "per_revenue", recorrente: false });
    if (repetia) {
      // Materializa nos meses seguintes que já existem (cadastro feito num mês
      // passado precisa alcançar até o mês corrente).
      try {
        await carryForwardFixedOverhead();
      } catch {
        // herança é conveniência — falhar aqui não pode derrubar o cadastro
      }
    }
  }

  async function handleRecorrenteToggle(id: string, recorrente: boolean) {
    setOverhead((rows) => rows.map((r) => (r.id === id ? { ...r, recorrente } : r)));
    await updateOverheadRecorrente(id, recorrente);
    // Desligar não precisa de limpeza: a herança só materializa até o mês
    // corrente, então não existe cópia futura pra remover.
    if (recorrente) {
      try {
        await carryForwardFixedOverhead();
      } catch {
        // idem
      }
    }
  }

  async function handleAddFixed() {
    const amount = parseMoney(newFixed.amount) ?? 0;
    if (!newFixed.category.trim()) return;
    const row = await insertOverhead({ category: newFixed.category.trim(), amount, is_marketing: false, allocation_method: newFixed.method, month: overheadMonth });
    setOverhead((rows) => [...rows, row]);
    setNewFixed({ category: "", amount: "0,00", method: "per_unit" });
    // Herda o gasto novo pros meses seguintes que já existem.
    try {
      await carryForwardFixedOverhead();
    } catch {
      // não fatal
    }
  }

  async function handleFeeRatesSave() {
    if (!feeRates) return;
    await updateFeeRates({
      taxa_shopify_pct: feeRates.taxa_shopify_pct,
      taxa_gateway_cartao_pct: feeRates.taxa_gateway_cartao_pct,
      taxa_gateway_pix_pct: feeRates.taxa_gateway_pix_pct,
      taxa_gateway_pix_fixo: feeRates.taxa_gateway_pix_fixo,
      taxa_antifraude_fixo: feeRates.taxa_antifraude_fixo,
      taxa_frete_estimado: feeRates.taxa_frete_estimado,
      imposto_pct: feeRates.imposto_pct,
      comissao_influencer_pct: feeRates.comissao_influencer_pct,
      sacolinha: feeRates.sacolinha,
      adesivo: feeRates.adesivo,
    });
    setFeeSaved(true);
    setTimeout(() => setFeeSaved(false), 2500);
  }

  async function handleProductCostBlur(id: string, field: keyof Omit<ProductCostRow, "id" | "sku" | "product_name">, value: string) {
    const parsed = parseMoney(value);
    if (parsed === null) return;
    setProductCosts((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: parsed } : r)));
    await updateProductCost(id, field, parsed);
  }

  async function handleAddProduct(draft: Omit<ProductCostRow, "id">, reset: () => void) {
    if (!draft.product_name.trim()) return;
    const row = await insertProductCost(draft);
    setProductCosts((rows) => [...rows, row]);
    reset();
  }

  async function handleProductNameBlur(id: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setProductCosts((rows) => rows.map((r) => (r.id === id ? { ...r, product_name: trimmed } : r)));
    await updateProductName(id, trimmed);
  }

  async function handleDeleteProduct(id: string) {
    setProductCosts((rows) => rows.filter((r) => r.id !== id));
    await deleteProductCost(id);
  }

  function handlePieceSort(field: keyof PieceMargin) {
    setPieceSort((s) => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: field === "sku" ? "asc" : "desc" }));
  }

  const marketingPool = overhead.filter((r) => r.is_marketing).reduce((sum, r) => sum + r.amount, 0);
  const fixedPool = overhead.filter((r) => !r.is_marketing).reduce((sum, r) => sum + r.amount, 0);

  // Só mostra o painel da coleção MAIS RECENTE (o drop atual — identificado
  // pelo published_at mais novo, sem precisar hardcodar o nome). Drops
  // antigos e peças sem coleção ficam escondidos, mas continuam no banco —
  // só não poluem mais a tela.
  const currentCollection = productCosts
    .filter((p) => p.collection && p.collection_published_at)
    .reduce<{ collection: string; publishedAt: string } | null>((latest, p) => {
      if (!latest || p.collection_published_at! > latest.publishedAt) {
        return { collection: p.collection!, publishedAt: p.collection_published_at! };
      }
      return latest;
    }, null);

  const productGroups: [string | null, ProductCostRow[]][] = currentCollection
    ? [[currentCollection.collection, productCosts.filter((p) => p.collection === currentCollection.collection)]]
    : [[null, productCosts.filter((p) => p.collection === null)]];

  // Peça sem custo de produção cadastrado entra no ranking com margem
  // fictícia (só sacolinha e adesivo contam como custo), então marca na
  // tabela. Peça que nem tem linha em product_costs cai no mesmo caso —
  // a venda casa por shopify_product_id e não achou nada.
  const pieceCostTotals = new Map(
    productCosts.map((p) => [p.product_name, p.tecido + p.estampa + p.costura + p.outros_acabamentos]),
  );
  const isCostMissing = (pieceName: string) => (pieceCostTotals.get(pieceName) ?? 0) === 0;

  if (!supabase) {
    return (
      <div className="app">
        <p className="page-sub">Supabase não configurado — faltam as variáveis de ambiente (.env).</p>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar subtitle="jackpot · admin">
        <div className="topbar-controls">
          <AdminBackLink />
          <SignOutButton />
        </div>
      </TopBar>

      <h1 className="page-title">Custos e taxas</h1>

      {error && <p className="page-sub" style={{ color: "var(--negative)" }}>{error}</p>}
      {loading && <p className="page-sub">Carregando...</p>}

      {!loading && (
        <>
          <div className="tabs">
            <div className={`tab ${tab === "sku" ? "active" : ""}`} onClick={() => setTab("sku")}>
              Custo de cada peça
              <span className="count">{productGroups.reduce((sum, [, products]) => sum + products.length, 0)}</span>
            </div>
            <div className={`tab ${tab === "fees" ? "active" : ""}`} onClick={() => setTab("fees")}>
              Taxas de venda
            </div>
            <div className={`tab ${tab === "overhead" ? "active" : ""}`} onClick={() => setTab("overhead")}>
              Gastos do mês
              <span className="count">{monthLabel(overheadMonth)}</span>
            </div>
            <div className={`tab ${tab === "frete" ? "active" : ""}`} onClick={() => setTab("frete")}>
              Frete
              <span className="count">{rangeLabel(profitRangeStart, profitRangeEnd)}</span>
            </div>
            <div className={`tab ${tab === "profit" ? "active" : ""}`} onClick={() => setTab("profit")}>
              Lucro por peça
              <span className="count">{rangeLabel(profitRangeStart, profitRangeEnd)}</span>
            </div>
            <div className={`tab ${tab === "coupon" ? "active" : ""}`} onClick={() => setTab("coupon")}>
              Cupom
              <span className="count">{rangeLabel(profitRangeStart, profitRangeEnd)}</span>
            </div>
            <div className={`tab ${tab === "payment" ? "active" : ""}`} onClick={() => setTab("payment")}>
              Pix / Cartão
              <span className="count">{rangeLabel(profitRangeStart, profitRangeEnd)}</span>
            </div>
          </div>

          {tab === "overhead" && (
            <>
              <div className="allocation-summary">
                <div className="as-cell">
                  <div className="as-label">Gasto com marketing</div>
                  <div className="as-value accent">R$ {money(marketingPool)}</div>
                </div>
                <div className="as-cell">
                  <div className="as-label">Gasto fixo</div>
                  <div className="as-value">R$ {money(fixedPool)}</div>
                </div>
                <div className="as-cell">
                  <div className="as-label">Mês</div>
                  <div className="as-value" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22, fontSize: 12 }}
                      onClick={() => setOverheadMonth((m) => shiftMonth(m, -1))}
                    >
                      ‹
                    </button>
                    {monthLabel(overheadMonth)}
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22, fontSize: 12 }}
                      onClick={() => setOverheadMonth((m) => shiftMonth(m, 1))}
                      disabled={overheadMonth >= currentMonthStart()}
                    >
                      ›
                    </button>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Marketing</div>
                    <div className="panel-hint">
                      Cada gasto pode ser fixo (mesmo valor pra toda peça vendida) ou variável (proporcional ao valor de cada venda).
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Nome do gasto</th>
                        <th className="num" style={{ width: 120 }}>Valor</th>
                        <th style={{ width: 170 }}>Como dividir</th>
                        <th style={{ width: 110 }}>Repete todo mês</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overhead.filter((row) => row.is_marketing).map((row) => (
                        <tr key={row.id}>
                          <td>{row.category}</td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(row.amount)} onBlur={(e) => handleAmountBlur(row.id, e.target.value)} />
                          </td>
                          <td>
                            <div className="method-toggle">
                              <button
                                type="button"
                                title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                                className={row.allocation_method === "per_unit" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_unit")}
                              >
                                Fixo
                              </button>
                              <button
                                type="button"
                                title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                                className={row.allocation_method === "per_revenue" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_revenue")}
                              >
                                Variável
                              </button>
                            </div>
                          </td>
                          <td>
                            <label className="check-cell" title="Herda pro mês seguinte com o mesmo valor, como um gasto fixo. Editar o valor propaga pros meses que ainda estão herdando.">
                              <input
                                type="checkbox"
                                checked={row.recorrente}
                                onChange={(e) => handleRecorrenteToggle(row.id, e.target.checked)}
                              />
                              <span>{row.recorrente ? "sim" : "não"}</span>
                            </label>
                          </td>
                          <td>
                            <div className="icon-cell" onClick={() => handleDeleteOverhead(row.id)}>✕</div>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <input
                            className="cell-text"
                            placeholder="Nome do novo gasto de marketing..."
                            style={{ width: 220 }}
                            value={newMarketing.category}
                            onChange={(e) => setNewMarketing((s) => ({ ...s, category: e.target.value }))}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="cell-input"
                            value={newMarketing.amount}
                            onChange={(e) => setNewMarketing((s) => ({ ...s, amount: e.target.value }))}
                          />
                        </td>
                        <td>
                          <div className="method-toggle">
                            <button
                              type="button"
                              title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                              className={newMarketing.method === "per_unit" ? "active" : ""}
                              onClick={() => setNewMarketing((s) => ({ ...s, method: "per_unit" }))}
                            >
                              Fixo
                            </button>
                            <button
                              type="button"
                              title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                              className={newMarketing.method === "per_revenue" ? "active" : ""}
                              onClick={() => setNewMarketing((s) => ({ ...s, method: "per_revenue" }))}
                            >
                              Variável
                            </button>
                          </div>
                        </td>
                        <td>
                          <label className="check-cell" title="Marque para esse gasto se repetir automaticamente nos próximos meses.">
                            <input
                              type="checkbox"
                              checked={newMarketing.recorrente}
                              onChange={(e) => setNewMarketing((s) => ({ ...s, recorrente: e.target.checked }))}
                            />
                            <span>{newMarketing.recorrente ? "sim" : "não"}</span>
                          </label>
                        </td>
                        <td>
                          <div className="icon-cell" onClick={handleAddMarketing}>+</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Fixos</div>
                    <div className="panel-hint">
                      Custos estruturais do negócio — plataforma, folha, contabilidade — que existem independente de quanto vendeu.
                      Se repetem sozinhos todo mês. Editar o valor num mês vale desse mês pra frente (meses passados não mudam); apagar tira desse mês em diante.
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Nome do gasto</th>
                        <th className="num" style={{ width: 120 }}>Valor</th>
                        <th style={{ width: 170 }}>Como dividir</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {overhead.filter((row) => !row.is_marketing).map((row) => (
                        <tr key={row.id}>
                          <td>{row.category}</td>
                          <td className="num">
                            <input className="cell-input" defaultValue={money(row.amount)} onBlur={(e) => handleAmountBlur(row.id, e.target.value)} />
                          </td>
                          <td>
                            <div className="method-toggle">
                              <button
                                type="button"
                                title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                                className={row.allocation_method === "per_unit" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_unit")}
                              >
                                Fixo
                              </button>
                              <button
                                type="button"
                                title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                                className={row.allocation_method === "per_revenue" ? "active" : ""}
                                onClick={() => handleMethodChange(row.id, "per_revenue")}
                              >
                                Variável
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="icon-cell" onClick={() => handleDeleteOverhead(row.id)}>✕</div>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <input
                            className="cell-text"
                            placeholder="Nome do novo gasto fixo..."
                            style={{ width: 220 }}
                            value={newFixed.category}
                            onChange={(e) => setNewFixed((s) => ({ ...s, category: e.target.value }))}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="cell-input"
                            value={newFixed.amount}
                            onChange={(e) => setNewFixed((s) => ({ ...s, amount: e.target.value }))}
                          />
                        </td>
                        <td>
                          <div className="method-toggle">
                            <button
                              type="button"
                              title="Mesmo valor pra toda peça vendida no mês, dividido igualmente"
                              className={newFixed.method === "per_unit" ? "active" : ""}
                              onClick={() => setNewFixed((s) => ({ ...s, method: "per_unit" }))}
                            >
                              Fixo
                            </button>
                            <button
                              type="button"
                              title="Valor proporcional ao preço de cada venda — quem vendeu mais caro absorve mais"
                              className={newFixed.method === "per_revenue" ? "active" : ""}
                              onClick={() => setNewFixed((s) => ({ ...s, method: "per_revenue" }))}
                            >
                              Variável
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="icon-cell" onClick={handleAddFixed}>+</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {tab === "frete" && (() => {
            const arrecadado = couponRows.reduce((s, r) => s + r.shipping_revenue, 0);
            const usado = couponRows.reduce((s, r) => s + r.shipping_cost, 0);
            const diferenca = couponRows.reduce((s, r) => s + r.shipping_adjustment, 0);
            const saldo = arrecadado - usado - diferenca;
            const pedidos = new Set(couponRows.map((r) => r.sale_id)).size;
            // Pedido sem etiqueta comprada (ou cujo custo o sistema de etiquetas ainda
            // não empurrou) entra com custo zero, porque taxa_frete_estimado
            // está em 0 de propósito — a gente quer o valor real, não chute.
            // Sem esse aviso o "Valor usado" parece completo e não é.
            const semCustoReal = new Set(
              couponRows.filter((r) => !r.has_real_shipping_cost).map((r) => r.sale_id),
            ).size;
            return (
              <>
                <div className="panel-head" style={{ padding: "0 0 16px" }}>
                  <div>
                    <div className="panel-title" style={{ marginBottom: 0 }}>Gastos de frete — {rangeLabel(profitRangeStart, profitRangeEnd)}</div>
                  </div>
                  <DateRangePicker
                    start={profitRangeStart}
                    end={profitRangeEnd}
                    maxDate={todayStr()}
                    onChange={(s, e) => { setProfitRangeStart(s); setProfitRangeEnd(e); }}
                  />
                </div>
                <div className="allocation-summary">
                  <div className="as-cell">
                    <div className="as-label">Valor arrecadado</div>
                    <div className="as-value accent">R$ {money(arrecadado)}</div>
                  </div>
                  <div className="as-cell">
                    <div className="as-label">Valor usado</div>
                    <div className="as-value">R$ {money(usado)}</div>
                  </div>
                  <div className="as-cell">
                    <div className="as-label">Diferença</div>
                    <div className="as-value" style={{ color: diferenca > 0 ? "var(--negative)" : undefined }}>R$ {money(diferenca)}</div>
                  </div>
                  <div className="as-cell">
                    <div className="as-label">Saldo final</div>
                    <div className="as-value" style={{ color: saldo >= 0 ? "var(--positive)" : "var(--negative)" }}>
                      R$ {money(saldo)}
                    </div>
                  </div>
                </div>
                <p className="page-sub" style={{ marginTop: 12 }}>
                  {pedidos} pedido{pedidos === 1 ? "" : "s"} no período.
                </p>
                {semCustoReal > 0 && (
                  <p className="page-sub" style={{ marginTop: 4, color: "var(--negative)" }}>
                    {semCustoReal} desses {semCustoReal === 1 ? "está" : "estão"} sem o custo real da etiqueta —
                    {" "}{semCustoReal === 1 ? "entrou" : "entraram"} pagando R$ 0,00, então "Valor usado" e "Saldo final" estão otimistas.
                  </p>
                )}
              </>
            );
          })()}

          {tab === "fees" && feeRates && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Taxas de venda — atuais</div>
                  <div className="panel-hint">Aplicadas em cima do valor de cada venda. Mudanças valem a partir da próxima atualização.</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {feeSaved && <span style={{ color: "var(--positive)", fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>Salvo</span>}
                  <button className="btn btn-primary" onClick={handleFeeRatesSave}>Salvar</button>
                </div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Taxa Shopify</label>
                  <input
                    defaultValue={`${(feeRates.taxa_shopify_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_shopify_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Taxa do cartão</label>
                  <input
                    defaultValue={`${(feeRates.taxa_gateway_cartao_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_gateway_cartao_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Taxa do Pix</label>
                  <input
                    defaultValue={`${(feeRates.taxa_gateway_pix_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_gateway_pix_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Taxa fixa do Pix</label>
                  <input
                    defaultValue={money(feeRates.taxa_gateway_pix_fixo)}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_gateway_pix_fixo: v });
                    }}
                  />
                  <div className="suffix">custo fixo por pedido pago via Pix</div>
                </div>
                <div className="field">
                  <label>Taxa antifraude (cartão)</label>
                  <input
                    defaultValue={money(feeRates.taxa_antifraude_fixo)}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_antifraude_fixo: v });
                    }}
                  />
                  <div className="suffix">custo fixo por pedido aprovado no cartão (Pix não tem)</div>
                </div>
                <div className="field">
                  <label>Frete — custo estimado</label>
                  <input
                    defaultValue={money(feeRates.taxa_frete_estimado)}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, taxa_frete_estimado: v });
                    }}
                  />
                  <div className="suffix">usado só enquanto o sistema de etiquetas não informa o frete real do pedido</div>
                </div>
                <div className="field">
                  <label>Imposto (Simples)</label>
                  <input
                    defaultValue={`${(feeRates.imposto_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, imposto_pct: v / 100 });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Comissão do influenciador</label>
                  <input
                    defaultValue={`${(feeRates.comissao_influencer_pct * 100).toFixed(2)}%`}
                    onBlur={(e) => {
                      const v = parsePercent(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, comissao_influencer_pct: v / 100 });
                    }}
                  />
                  <div className="suffix">mesma taxa do painel de comissão</div>
                </div>
                <div className="field">
                  <label>Sacolinha</label>
                  <input
                    defaultValue={money(feeRates.sacolinha)}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, sacolinha: v });
                    }}
                  />
                  <div className="suffix">custo fixo por peça, igual pra todas</div>
                </div>
                <div className="field">
                  <label>Adesivo</label>
                  <input
                    defaultValue={money(feeRates.adesivo)}
                    onBlur={(e) => {
                      const v = parseMoney(e.target.value);
                      if (v !== null) setFeeRates({ ...feeRates, adesivo: v });
                    }}
                  />
                  <div className="suffix">custo fixo por peça, igual pra todas</div>
                </div>
              </div>
            </div>
          )}

          {tab === "sku" && (
            <>
              {productGroups.map(([collection, products]) => (
                <ProductPanel
                  key={collection ?? "sem-colecao"}
                  title={`Custo de cada peça — ${collection ?? "Sem coleção"}`}
                  products={products}
                  newProduct={newProduct}
                  setNewProduct={setNewProduct}
                  onCostBlur={handleProductCostBlur}
                  onNameBlur={handleProductNameBlur}
                  onDelete={handleDeleteProduct}
                  onAdd={() =>
                    handleAddProduct({ ...newProduct, collection }, () => setNewProduct(emptyProductCost(collection)))
                  }
                />
              ))}
            </>
          )}

          {tab === "profit" && (
            <>
              <div className="panel-head" style={{ padding: "0 0 16px" }}>
                <div>
                  <div className="panel-title" style={{ marginBottom: 0 }}>Lucro por peça — {rangeLabel(profitRangeStart, profitRangeEnd)}</div>
                  <div className="panel-hint">
                    Peças vendidas no período — clique no cabeçalho pra ordenar. O lucro aqui é o líquido:
                    já desconta custo da peça, taxas de venda, marketing e fixos rateados e o resultado do frete.
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <DateRangePicker
                    start={profitRangeStart}
                    end={profitRangeEnd}
                    maxDate={todayStr()}
                    onChange={(s, e) => { setProfitRangeStart(s); setProfitRangeEnd(e); }}
                  />
                  <input
                    className="cell-text"
                    placeholder="Buscar peça..."
                    value={pieceSearch}
                    onChange={(e) => setPieceSearch(e.target.value)}
                    style={{ width: 160 }}
                  />
                </div>
              </div>
              <PieceMarginTable
                title="Lucro por peça"
                hint="Todas as peças com venda no período."
                rows={pieceMargin.filter((row) => row.sku.toLowerCase().includes(pieceSearch.trim().toLowerCase()))}
                sort={pieceSort}
                onSort={handlePieceSort}
                emptyMessage={pieceMargin.length === 0 ? "Nenhuma venda ainda esse mês." : "Nenhuma peça encontrada."}
                isCostMissing={isCostMissing}
              />
            </>
          )}

          {tab === "profit" && (() => {
            const excluded = [/gift\s*card/i];
            const soldNames = new Set(pieceMargin.map((row) => row.sku));
            const unsold = productCosts.filter(
              (p) =>
                !soldNames.has(p.product_name) &&
                !excluded.some((re) => re.test(p.product_name)) &&
                // drop antigo não é anomalia — só interessa peça sem venda
                // do drop atual (ou sem coleção, se não tiver drop atual).
                p.collection === (currentCollection?.collection ?? null),
            );
            return (
              <div className="panel" style={{ marginTop: 16 }}>
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Sem venda no período</div>
                    <div className="panel-hint">
                      Peças cadastradas mas sem nenhuma venda em {rangeLabel(profitRangeStart, profitRangeEnd)}. Preenche um preço de venda planejado pra ver o lucro estimado — é projeção no pior caso (cartão e com cupom, sem rateio de marketing/fixo), não lucro real até vender de verdade.
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Peça</th>
                        <th className="num">Custo direto/un.</th>
                        <th className="num">Preço de venda</th>
                        <th className="num">Lucro estimado/un.</th>
                        <th className="num">Margem estimada</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unsold.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ color: "var(--ink-faint)" }}>Toda peça cadastrada teve venda nesse período.</td>
                        </tr>
                      ) : (
                        unsold.map((p) => {
                          const directCost = p.tecido + p.estampa + p.costura + p.outros_acabamentos
                            + (feeRates?.sacolinha ?? 0) + (feeRates?.adesivo ?? 0);
                          const preco = p.preco_venda;
                          const saleCostPct = feeRates
                            ? feeRates.taxa_shopify_pct + feeRates.taxa_gateway_cartao_pct + feeRates.imposto_pct
                              + feeRates.comissao_influencer_pct
                            : 0;
                          const estimatedProfit = preco !== null ? preco - directCost - preco * saleCostPct : null;
                          const estimatedMarginPct = preco !== null && preco > 0 ? (estimatedProfit! / preco) * 100 : null;
                          return (
                            <tr key={p.id}>
                              <td className="sku">{p.product_name}</td>
                              <td className="num">R$ {money(directCost)}</td>
                              <td className="num">
                                <input
                                  className="cell-input"
                                  defaultValue={preco !== null ? money(preco) : ""}
                                  placeholder="0,00"
                                  onBlur={(e) => handleProductCostBlur(p.id, "preco_venda", e.target.value)}
                                />
                              </td>
                              <td className="num">{estimatedProfit !== null ? `R$ ${money(estimatedProfit)}` : "—"}</td>
                              <td className="num">
                                {estimatedMarginPct !== null ? (
                                  <span className={`margin-pill ${marginClass(estimatedMarginPct)}`}>{estimatedMarginPct.toFixed(1)}%</span>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {tab === "coupon" && (
            <>
              <div className="panel-head" style={{ padding: "0 0 16px" }}>
                <div>
                  <div className="panel-title" style={{ marginBottom: 0 }}>Cupom — {rangeLabel(profitRangeStart, profitRangeEnd)}</div>
                  <div className="panel-hint">DRE separado por pedido ter usado cupom de desconto ou não.</div>
                </div>
                <DateRangePicker
                  start={profitRangeStart}
                  end={profitRangeEnd}
                  maxDate={todayStr()}
                  onChange={(s, e) => { setProfitRangeStart(s); setProfitRangeEnd(e); }}
                />
              </div>
              <DreWaterfall
                title="DRE — Com cupom"
                hint={`${new Set(couponRows.filter((r) => r.has_coupon).map((r) => r.sale_id)).size} vendas com código de desconto aplicado`}
                dre={aggregateDre(couponRows.filter((r) => r.has_coupon))}
              />
              <DreWaterfall
                title="DRE — Sem cupom"
                hint={`${new Set(couponRows.filter((r) => !r.has_coupon).map((r) => r.sale_id)).size} vendas sem código de desconto`}
                dre={aggregateDre(couponRows.filter((r) => !r.has_coupon))}
              />
            </>
          )}

          {tab === "payment" && (
            <>
              <div className="panel-head" style={{ padding: "0 0 16px" }}>
                <div>
                  <div className="panel-title" style={{ marginBottom: 0 }}>Pix / Cartão — {rangeLabel(profitRangeStart, profitRangeEnd)}</div>
                  <div className="panel-hint">DRE separado por forma de pagamento da venda.</div>
                </div>
                <DateRangePicker
                  start={profitRangeStart}
                  end={profitRangeEnd}
                  maxDate={todayStr()}
                  onChange={(s, e) => { setProfitRangeStart(s); setProfitRangeEnd(e); }}
                />
              </div>
              <DreWaterfall
                title="DRE — Pix"
                hint={`${new Set(couponRows.filter((r) => r.payment_method === "pix").map((r) => r.sale_id)).size} vendas pagas via Pix`}
                dre={aggregateDre(couponRows.filter((r) => r.payment_method === "pix"))}
              />
              <DreWaterfall
                title="DRE — Cartão"
                hint={`${new Set(couponRows.filter((r) => r.payment_method === "cartao").map((r) => r.sale_id)).size} vendas pagas via cartão`}
                dre={aggregateDre(couponRows.filter((r) => r.payment_method === "cartao"))}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
