import { useEffect, useState } from "react";
import { TopBar, AdminLink } from "../components/TopBar";
import { SignOutButton } from "../components/RequireAuth";
import { DateRangePicker } from "../components/DateRangePicker";
import { DreWaterfall, aggregateDre, type DreTotals } from "../components/DreWaterfall";
import {
  fetchSaleMarginForRange,
  fetchLastSyncTime,
  currentMonthStart,
  todayStr,
  previousPeriod,
} from "../lib/queries";
import { supabase } from "../lib/supabase";

function money(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function dateLabel(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function rangeLabel(start: string, end: string) {
  const startYear = start.slice(0, 4);
  const endYear = end.slice(0, 4);
  if (start === end) return `${dateLabel(start)}/${endYear}`;
  return startYear === endYear ? `${dateLabel(start)} a ${dateLabel(end)}/${endYear}` : `${dateLabel(start)}/${startYear} a ${dateLabel(end)}/${endYear}`;
}
function timeAgo(iso: string) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const hours = Math.round(diffMin / 60);
  return `há ${hours}h`;
}

interface DashboardData {
  dre: DreTotals;
  prevDre: DreTotals | null;
  lastSync: string | null;
}

export function Dashboard() {
  const [rangeStart, setRangeStart] = useState(currentMonthStart());
  const [rangeEnd, setRangeEnd] = useState(todayStr());
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const prev = previousPeriod(rangeStart, rangeEnd);
        const [rows, prevRows, lastSync] = await Promise.all([
          fetchSaleMarginForRange(rangeStart, rangeEnd),
          fetchSaleMarginForRange(prev.start, prev.end),
          fetchLastSyncTime(),
        ]);
        if (cancelled) return;
        const dre = aggregateDre(rows);
        const prevDre = prevRows.length > 0 ? aggregateDre(prevRows) : null;
        setData({ dre, prevDre, lastSync });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erro ao carregar dados.");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [rangeStart, rangeEnd]);

  if (!supabase) {
    return (
      <div className="app">
        <p className="page-sub">Supabase não configurado — faltam as variáveis de ambiente (.env).</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <TopBar subtitle="jackpot">
          <div className="topbar-controls">
            <AdminLink />
            <SignOutButton />
          </div>
        </TopBar>
        <p className="page-sub">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app">
        <p className="page-sub">Carregando...</p>
      </div>
    );
  }

  const { dre, prevDre, lastSync } = data;
  const totalCost = dre.direct_cost + dre.sale_cost + dre.marketing_cost + dre.fixed_cost;
  const netMarginPct = dre.gross_revenue > 0 ? (dre.net_profit / dre.gross_revenue) * 100 : 0;
  const grossDeltaPct = prevDre && prevDre.gross_revenue > 0 ? ((dre.gross_revenue - prevDre.gross_revenue) / prevDre.gross_revenue) * 100 : null;

  return (
    <div className="app">
      <TopBar subtitle="jackpot">
        <div className="topbar-controls">
          <AdminLink />
          <SignOutButton />
        </div>
      </TopBar>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Visão geral — {rangeLabel(rangeStart, rangeEnd)}</h1>
          {lastSync && <p className="page-sub">última sincronização {timeAgo(lastSync)}</p>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DateRangePicker
            start={rangeStart}
            end={rangeEnd}
            maxDate={todayStr()}
            onChange={(s, e) => { setRangeStart(s); setRangeEnd(e); }}
          />
          <button type="button" className="btn btn-ghost" onClick={() => { setRangeStart(currentMonthStart()); setRangeEnd(todayStr()); }}>
            Mês atual
          </button>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Faturamento</div>
          <div className="kpi-value">R$ {money(dre.gross_revenue)}</div>
          {prevDre && (
            <div className={`kpi-delta ${grossDeltaPct !== null && grossDeltaPct >= 0 ? "up" : "down"}`}>
              R$ {money(prevDre.gross_revenue)} período anterior
              {grossDeltaPct !== null && <> · {grossDeltaPct >= 0 ? "↑" : "↓"} {Math.abs(grossDeltaPct).toFixed(1)}%</>}
            </div>
          )}
        </div>
        <div className="kpi">
          <div className="kpi-label">Custos totais</div>
          <div className="kpi-value">R$ {money(totalCost)}</div>
          <div className="kpi-delta down">{dre.gross_revenue > 0 ? ((totalCost / dre.gross_revenue) * 100).toFixed(1) : 0}% do fat.</div>
        </div>
        <div className="kpi hero">
          <div className="kpi-label">Lucro líquido</div>
          <div className="kpi-value">R$ {money(dre.net_profit)}</div>
          <div className="kpi-delta up">margem {netMarginPct.toFixed(1)}%</div>
        </div>
      </div>

      <DreWaterfall title="DRE do período" hint="faturamento → lucro líquido" dre={dre} />
    </div>
  );
}
