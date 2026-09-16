-- ----------------------------------------------------------------------------
-- Adiciona fotolito, gravação de tela e corte ao custo direto da peça —
-- mesmo balde de tecido/estampa/costura/outros_acabamentos, só quebrado em
-- mais etapas de produção pra facilitar o preenchimento.
-- ----------------------------------------------------------------------------
alter table product_costs add column if not exists fotolito numeric(10,2) not null default 0;
alter table product_costs add column if not exists gravacao_tela numeric(10,2) not null default 0;
alter table product_costs add column if not exists corte numeric(10,2) not null default 0;

create or replace view sale_margin as
with order_totals as (
  select shopify_order_id, sum(gross_amount - discount_amount) as order_net
  from sale_revenue
  group by 1
),
components as (
  select
    sr.shopify_order_id::text as sale_id,
    sr.product_sku,
    sr.product_name,
    sr.quantity,
    (sr.gross_amount - sr.discount_amount) as gross_amount,
    sr.discount_amount,
    sr.sale_date,
    (
      coalesce(pc.tecido, 0::numeric) + coalesce(pc.estampa, 0::numeric) + coalesce(pc.costura, 0::numeric)
      + coalesce(pc.outros_acabamentos, 0::numeric) + coalesce(pc.fotolito, 0::numeric)
      + coalesce(pc.gravacao_tela, 0::numeric) + coalesce(pc.corte, 0::numeric)
      + coalesce(fr.sacolinha, 0::numeric) + coalesce(fr.adesivo, 0::numeric)
    ) * sr.quantity::numeric as direct_cost,
    -- coalesce externo: pedido inteiro zerado (brinde, 100% de cupom) faz
    -- order_net = 0, o rateio vira NULL e contaminaria o lucro. Nesse caso o
    -- custo rateado é 0 mesmo.
    round(coalesce(
      -- taxas percentuais incidem sobre produto + frete cobrado
      (
        (sr.gross_amount - sr.discount_amount)
        + coalesce(os.revenue, 0::numeric)
            * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
      ) * (
        fr.taxa_shopify_pct
        + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
        + fr.imposto_pct
      )
      -- comissão de influencer: só com cupom, e só sobre o produto
      + (sr.gross_amount - sr.discount_amount)
          * fr.comissao_influencer_pct * case when sr.has_coupon then 1 else 0 end
      -- taxa fixa do pedido (pix fixo ou antifraude), rateada por item
      + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_fixo else fr.taxa_antifraude_fixo end
          * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as sale_cost,
    round(coalesce(oa.marketing_cost, 0::numeric), 2) as marketing_cost,
    round(coalesce(oa.fixed_cost, 0::numeric), 2) as fixed_cost,
    round(coalesce(
      coalesce(os.revenue, 0::numeric)
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_revenue,
    round(coalesce(
      coalesce(os.cost, fr.taxa_frete_estimado)
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_cost,
    round(coalesce(
      coalesce(os.cost_adjustment, 0::numeric)
        * (sr.gross_amount - sr.discount_amount) / nullif(ot.order_net, 0::numeric)
    , 0::numeric), 2) as shipping_adjustment,
    -- false = a etiqueta desse pedido ainda não teve o custo informado, então
    -- shipping_cost caiu no estimado. A aba Frete conta quantos estão assim.
    (os.cost is not null) as has_real_shipping_cost,
    coalesce(pc.product_name, sr.product_name) as piece_name,
    sr.has_coupon,
    sr.payment_method
  from sale_revenue sr
  left join product_costs pc on pc.shopify_product_id = sr.shopify_product_id
  left join sale_overhead_allocation oa
    on oa.sale_id = sr.shopify_order_id and oa.shopify_line_item_id = sr.shopify_line_item_id
  left join order_totals ot on ot.shopify_order_id = sr.shopify_order_id
  left join order_shipping os on os.shopify_order_id = sr.shopify_order_id
  cross join sale_fee_rates fr
  where fr.id = 1
)
select
  sale_id,
  product_sku,
  product_name,
  quantity,
  gross_amount,
  discount_amount,
  sale_date,
  direct_cost,
  sale_cost,
  marketing_cost,
  fixed_cost,
  shipping_revenue,
  shipping_cost,
  shipping_adjustment,
  has_real_shipping_cost,
  round(
    gross_amount - direct_cost - sale_cost - marketing_cost - fixed_cost
    + shipping_revenue - shipping_cost - shipping_adjustment
  , 2) as net_profit,
  piece_name,
  has_coupon,
  payment_method
from components;

-- CREATE OR REPLACE VIEW não garante que reloptions (security_invoker)
-- sobrevivam — reforça explicitamente toda vez que a view for recriada,
-- senão a RLS das tabelas de baixo vaza pra qualquer authenticated.
alter view sale_margin set (security_invoker = true);
