-- ----------------------------------------------------------------------------
-- Corrige sale_overhead_allocation: custo FIXO manually_edited estava sendo
-- rateado por dia decorrido do mês igual um valor projetado, contradizendo
-- o próprio comentário da view ("valor digitado na mão é dinheiro já gasto e
-- entra inteiro") — essa regra só tinha sido implementada pro lado de
-- marketing (linha do `marketing_cost`), não pro fixo. Agora os dois ramos
-- pulam o rateio por dia quando manually_edited = true.
-- ----------------------------------------------------------------------------
create or replace view sale_overhead_allocation as
select
  sr.shopify_order_id as sale_id,
  sr.shopify_line_item_id,
  coalesce(sum(
    (case
      when mo.allocation_method = 'per_unit' then (mo.amount * sr.quantity::numeric) / nullif(mt.units, 0)::numeric
      else (mo.amount * (sr.gross_amount - sr.discount_amount)) / nullif(mt.revenue, 0::numeric)
    end)
    * case
        when mt.month <> date_trunc('month', now())::date then 1::numeric
        when not mo.recorrente or mo.manually_edited then 1::numeric
        else least(
          1::numeric,
          extract(day from now())::numeric
            / extract(day from (date_trunc('month', now()) + interval '1 month' - interval '1 day'))::numeric
        )
      end
  ) filter (where mo.is_marketing), 0::numeric) as marketing_cost,
  coalesce(sum(
    (case
      when mo.allocation_method = 'per_unit' then (mo.amount * sr.quantity::numeric) / nullif(mt.units, 0)::numeric
      else (mo.amount * (sr.gross_amount - sr.discount_amount)) / nullif(mt.revenue, 0::numeric)
    end)
    * case
        when mt.month <> date_trunc('month', now())::date then 1::numeric
        when mo.manually_edited then 1::numeric
        else least(
          1::numeric,
          extract(day from now())::numeric
            / extract(day from (date_trunc('month', now()) + interval '1 month' - interval '1 day'))::numeric
        )
      end
  ) filter (where not mo.is_marketing), 0::numeric) as fixed_cost
from sale_revenue sr
join monthly_totals mt on mt.month = date_trunc('month', sr.sale_date)::date
left join monthly_overhead mo on mo.month = mt.month
group by 1, 2;

alter view sale_overhead_allocation set (security_invoker = true);
