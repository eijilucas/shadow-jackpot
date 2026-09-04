-- ============================================================================
-- Shadow of the Fallen — Jackpot
-- Schema consolidado (adaptado do projeto irmão "Mental Madness — Jackpot").
-- Uma loja Shopify só aqui, então sem o conceito de product_line
-- (básico/exclusivo) do projeto original — só "coleção" (drop), que já
-- é suficiente pra agrupar peça por lançamento.
-- Rode este arquivo inteiro no SQL Editor do Supabase, ou via:
--   npx supabase db push
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- TABELA: sale_revenue (alimentada pelo webhook/import da Shopify — só
-- leitura pro resto do sistema). Uma linha por item de pedido.
-- ----------------------------------------------------------------------------
create table if not exists sale_revenue (
  shopify_order_id bigint not null,
  shopify_line_item_id bigint not null,
  shopify_product_id bigint not null,
  product_sku text,
  product_name text not null,
  quantity integer not null default 1 check (quantity > 0),
  gross_amount numeric(12,2) not null check (gross_amount >= 0),
  sale_date timestamptz not null,
  synced_at timestamptz not null default now(),
  has_coupon boolean not null default false,
  payment_method text not null default 'cartao' check (payment_method in ('cartao', 'pix')),
  primary key (shopify_order_id, shopify_line_item_id)
);

create index if not exists idx_sale_revenue_sale_date on sale_revenue (sale_date);
create index if not exists idx_sale_revenue_order on sale_revenue (shopify_order_id);

-- ----------------------------------------------------------------------------
-- TABELA: product_costs (camada 1 — custo direto por peça, uma linha por
-- produto na Shopify — não por variante, já que tecido/estampa/costura é
-- o mesmo em qualquer tamanho).
-- ----------------------------------------------------------------------------
create table if not exists product_costs (
  id uuid primary key default gen_random_uuid(),
  shopify_product_id bigint unique,
  sku text,
  product_name text not null,
  tecido numeric(10,2) not null default 0,
  estampa numeric(10,2) not null default 0,
  costura numeric(10,2) not null default 0,
  outros_acabamentos numeric(10,2) not null default 0,
  collection text,
  collection_published_at timestamptz,
  preco_venda numeric(10,2),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- TABELA: sale_fee_rates (camada 2 — custos da venda). Linha única
-- (id = 1). Taxa de gateway separada por forma de pagamento: cartão é só
-- percentual, Pix é percentual + fixo por pedido.
-- ----------------------------------------------------------------------------
create table if not exists sale_fee_rates (
  id smallint primary key default 1 check (id = 1),
  taxa_shopify_pct numeric(6,4) not null default 0.0290,
  taxa_gateway_cartao_pct numeric(6,4) not null default 0.0500,
  taxa_gateway_pix_pct numeric(6,4) not null default 0.0100,
  taxa_gateway_pix_fixo numeric(10,2) not null default 1.00,
  imposto_pct numeric(6,4) not null default 0.0600,
  comissao_influencer_pct numeric(6,4) not null default 0.0500,
  desconto_medio_pct numeric(6,4) not null default 0,
  sacolinha numeric(10,2) not null default 0,
  adesivo numeric(10,2) not null default 0,
  updated_at timestamptz not null default now()
);

insert into sale_fee_rates (id) values (1) on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- TABELA: monthly_overhead (camadas 3 e 4 — marketing e fixos, por mês).
-- ----------------------------------------------------------------------------
create table if not exists monthly_overhead (
  id uuid primary key default gen_random_uuid(),
  month date not null, -- sempre o dia 1 do mês
  category text not null,
  amount numeric(12,2) not null check (amount >= 0),
  is_marketing boolean not null,
  allocation_method text not null check (allocation_method in ('per_unit', 'per_revenue')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_monthly_overhead_month on monthly_overhead (month);

-- ----------------------------------------------------------------------------
-- VIEW: monthly_totals — base de rateio.
-- ----------------------------------------------------------------------------
create or replace view monthly_totals as
select
  date_trunc('month', sale_date)::date as month,
  sum(quantity) as units,
  sum(gross_amount) as revenue
from sale_revenue
group by 1;

-- ----------------------------------------------------------------------------
-- VIEW: sale_overhead_allocation — quanto de marketing/fixo cada venda
-- absorve.
-- ----------------------------------------------------------------------------
create or replace view sale_overhead_allocation as
select
  sr.shopify_order_id as sale_id,
  sr.shopify_line_item_id,
  coalesce(sum(
    case when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
         else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where mo.is_marketing), 0) as marketing_cost,
  coalesce(sum(
    case when mo.allocation_method = 'per_unit' then mo.amount * sr.quantity / nullif(mt.units, 0)
         else mo.amount * sr.gross_amount / nullif(mt.revenue, 0)
    end
  ) filter (where not mo.is_marketing), 0) as fixed_cost
from sale_revenue sr
join monthly_totals mt on mt.month = date_trunc('month', sr.sale_date)::date
left join monthly_overhead mo on mo.month = mt.month
group by sr.shopify_order_id, sr.shopify_line_item_id;

-- ----------------------------------------------------------------------------
-- VIEW: sale_margin — o cálculo completo, por item de venda. Taxa de
-- gateway varia por payment_method; Pix soma um valor fixo rateado
-- proporcionalmente entre os itens do mesmo pedido (a taxa é por pedido,
-- não por item).
-- ----------------------------------------------------------------------------
create or replace view sale_margin as
select
  sr.shopify_order_id as sale_id,
  sr.product_sku,
  sr.product_name,
  sr.quantity,
  sr.gross_amount,
  sr.sale_date,
  (coalesce(pc.tecido, 0) + coalesce(pc.estampa, 0) + coalesce(pc.costura, 0)
    + coalesce(fr.sacolinha, 0) + coalesce(fr.adesivo, 0) + coalesce(pc.outros_acabamentos, 0)) * sr.quantity
    as direct_cost,
  round(
    sr.gross_amount * (
      fr.taxa_shopify_pct
      + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
      + fr.imposto_pct + fr.comissao_influencer_pct + fr.desconto_medio_pct
    )
    + case when sr.payment_method = 'pix'
        then fr.taxa_gateway_pix_fixo * sr.gross_amount / nullif(ot.order_gross, 0)
        else 0
      end
  , 2) as sale_cost,
  round(coalesce(oa.marketing_cost, 0), 2) as marketing_cost,
  round(coalesce(oa.fixed_cost, 0), 2) as fixed_cost,
  round(
    sr.gross_amount
    - (coalesce(pc.tecido, 0) + coalesce(pc.estampa, 0) + coalesce(pc.costura, 0)
        + coalesce(fr.sacolinha, 0) + coalesce(fr.adesivo, 0) + coalesce(pc.outros_acabamentos, 0)) * sr.quantity
    - (
        sr.gross_amount * (
          fr.taxa_shopify_pct
          + case when sr.payment_method = 'pix' then fr.taxa_gateway_pix_pct else fr.taxa_gateway_cartao_pct end
          + fr.imposto_pct + fr.comissao_influencer_pct + fr.desconto_medio_pct
        )
        + case when sr.payment_method = 'pix'
            then fr.taxa_gateway_pix_fixo * sr.gross_amount / nullif(ot.order_gross, 0)
            else 0
          end
      )
    - coalesce(oa.marketing_cost, 0)
    - coalesce(oa.fixed_cost, 0)
  , 2) as net_profit,
  coalesce(pc.product_name, sr.product_name) as piece_name,
  sr.has_coupon,
  sr.payment_method
from sale_revenue sr
left join product_costs pc on pc.shopify_product_id = sr.shopify_product_id
left join sale_overhead_allocation oa on oa.sale_id = sr.shopify_order_id and oa.shopify_line_item_id = sr.shopify_line_item_id
left join (
  select shopify_order_id, sum(gross_amount) as order_gross
  from sale_revenue
  group by shopify_order_id
) ot on ot.shopify_order_id = sr.shopify_order_id
cross join sale_fee_rates fr
where fr.id = 1;

-- ----------------------------------------------------------------------------
-- VIEW: monthly_dre — o mesmo cálculo, somado por mês.
-- ----------------------------------------------------------------------------
create or replace view monthly_dre as
select
  date_trunc('month', sale_date)::date as month,
  sum(gross_amount) as gross_revenue,
  sum(direct_cost) as direct_cost,
  sum(sale_cost) as sale_cost,
  sum(marketing_cost) as marketing_cost,
  sum(fixed_cost) as fixed_cost,
  sum(net_profit) as net_profit
from sale_margin
group by 1;

-- CREATE OR REPLACE VIEW não garante que reloptions (security_invoker)
-- sobrevivam — reforça explicitamente toda vez que a view for recriada,
-- senão RLS das tabelas de baixo vaza pra qualquer authenticated.
alter view monthly_totals set (security_invoker = true);
alter view sale_overhead_allocation set (security_invoker = true);
alter view sale_margin set (security_invoker = true);
alter view monthly_dre set (security_invoker = true);

-- ----------------------------------------------------------------------------
-- Autenticação — só quem está em admin_emails acessa qualquer dado
-- sensível. Sem self-signup: conta é criada manualmente pelo admin
-- (Supabase Dashboard → Authentication → Users → Add user), com "Allow
-- new users to sign up" desligado no projeto.
-- ----------------------------------------------------------------------------
create table if not exists admin_emails (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table admin_emails enable row level security;
-- Sem policy de select/insert/update/delete pra client autenticado: só
-- quem tem acesso ao SQL Editor / Service Role mexe nesta tabela.

create or replace function is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from admin_emails where email = auth.jwt() ->> 'email'
  );
$$;

-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
alter table sale_revenue enable row level security;
alter table product_costs enable row level security;
alter table sale_fee_rates enable row level security;
alter table monthly_overhead enable row level security;

drop policy if exists sale_revenue_admin_only on sale_revenue;
create policy sale_revenue_admin_only on sale_revenue
  for select using (is_admin_user());

drop policy if exists product_costs_admin_all on product_costs;
create policy product_costs_admin_all on product_costs
  for all using (is_admin_user()) with check (is_admin_user());

drop policy if exists sale_fee_rates_admin_all on sale_fee_rates;
create policy sale_fee_rates_admin_all on sale_fee_rates
  for all using (is_admin_user()) with check (is_admin_user());

drop policy if exists monthly_overhead_admin_all on monthly_overhead;
create policy monthly_overhead_admin_all on monthly_overhead
  for all using (is_admin_user()) with check (is_admin_user());

-- sale_revenue nunca recebe insert/update/delete de um client autenticado
-- comum: a sincronização roda com a Service Role, fora do RLS.

-- Preencher com o(s) e-mail(s) que podem administrar este projeto:
-- insert into admin_emails (email) values ('admin@exemplo.com') on conflict (email) do nothing;
