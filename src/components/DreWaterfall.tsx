import type { SaleMarginRow } from "../lib/queries";

function moneyCents(v: number) {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface DreTotals {
  gross_revenue: number;
  direct_cost: number;
  sale_cost: number;
  marketing_cost: number;
  fixed_cost: number;
  net_profit: number;
}

export function aggregateDre(rows: SaleMarginRow[]): DreTotals {
  return rows.reduce<DreTotals>(
    (acc, r) => ({
      gross_revenue: acc.gross_revenue + r.gross_amount,
      direct_cost: acc.direct_cost + r.direct_cost,
      sale_cost: acc.sale_cost + r.sale_cost,
      marketing_cost: acc.marketing_cost + r.marketing_cost,
      fixed_cost: acc.fixed_cost + r.fixed_cost,
      net_profit: acc.net_profit + r.net_profit,
    }),
    { gross_revenue: 0, direct_cost: 0, sale_cost: 0, marketing_cost: 0, fixed_cost: 0, net_profit: 0 },
  );
}

export function DreWaterfall({ title, hint, dre }: { title: string; hint: string; dre: DreTotals }) {
  const afterDirect = dre.gross_revenue - dre.direct_cost;
  const afterSaleCost = afterDirect - dre.sale_cost;
  const afterMarketing = afterSaleCost - dre.marketing_cost;

  function waterfallWidth(value: number) {
    return `${dre.gross_revenue > 0 ? ((value / dre.gross_revenue) * 100).toFixed(1) : 0}%`;
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        <span className="panel-hint">{hint}</span>
      </div>
      <div className="panel-body">
        {dre.gross_revenue === 0 ? (
          <p className="page-sub" style={{ margin: 0 }}>Nenhuma venda dessa linha no período.</p>
        ) : (
          <div className="waterfall">
            <div className="wf-row">
              <div className="wf-label strong">Faturamento</div>
              <div className="wf-track">
                <div className="wf-fill neutral" style={{ width: "100%" }} />
              </div>
              <div className="wf-value">R$ {moneyCents(dre.gross_revenue)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.direct_cost)} · custo direto</div>
            <div className="wf-row">
              <div className="wf-label">Após custo direto</div>
              <div className="wf-track">
                <div className="wf-fill" style={{ width: waterfallWidth(afterDirect) }} />
              </div>
              <div className="wf-value">R$ {moneyCents(afterDirect)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.sale_cost)} · custos da venda</div>
            <div className="wf-row">
              <div className="wf-label">Após custos da venda</div>
              <div className="wf-track">
                <div className="wf-fill" style={{ width: waterfallWidth(afterSaleCost) }} />
              </div>
              <div className="wf-value">R$ {moneyCents(afterSaleCost)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.marketing_cost)} · marketing rateado</div>
            <div className="wf-row">
              <div className="wf-label">Após marketing</div>
              <div className="wf-track">
                <div className="wf-fill" style={{ width: waterfallWidth(afterMarketing) }} />
              </div>
              <div className="wf-value">R$ {moneyCents(afterMarketing)}</div>
            </div>
            <div className="wf-cut">− R$ {moneyCents(dre.fixed_cost)} · fixos rateados</div>
            <div className="wf-row">
              <div className="wf-label strong">Lucro líquido</div>
              <div className="wf-track">
                <div className="wf-fill final" style={{ width: waterfallWidth(dre.net_profit) }} />
              </div>
              <div className="wf-value final">R$ {moneyCents(dre.net_profit)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
