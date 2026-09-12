-- ============================================================================
-- Shadow of the Fallen — Jackpot
-- Schema consolidado (adaptado do projeto irmão "Mental Madness — Jackpot",
-- já com todas as correções de cálculo aplicadas lá até 13/09/2026).
--
-- Uma loja Shopify só aqui, então sem o conceito de product_line
-- (básico/exclusivo) nem de venda fora do site (source) do projeto original —
-- só "coleção" (drop), que já é suficiente pra agrupar peça por lançamento.
--
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
  -- Preço de tabela. O que entrou de verdade é gross_amount - discount_amount.
  gross_amount numeric(12,2) not null check (gross_amount >= 0),
  discount_amount numeric(12,2) not null default 0,
  sale_date timestamptz not null,
  synced_at timestamptz not null default now(),
  has_coupon boolean not null default false,
  payment_method text not null default 'cartao' check (payment_method in ('cartao', 'pix')),
  primary key (shopify_order_id, shopify_line_item_id)
);

comment on column sale_revenue.discount_amount is
  'Cupom/desconto do item (discount_allocations, ou total_discount quando o desconto é direto na linha). gross_amount continua sendo o preço de tabela; o líquido é gross_amount - discount_amount.';

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
-- (id = 1). Taxa de gateway separada por forma de pagamento: cartão é
-- percentual + antifraude fixo, Pix é percentual + fixo por pedido.
-- ----------------------------------------------------------------------------
create table if not exists sale_fee_rates (
  id smallint primary key default 1 check (id = 1),
  taxa_shopify_pct numeric(6,4) not null default 0.0290,
  taxa_gateway_cartao_pct numeric(6,4) not null default 0.0500,
  taxa_gateway_pix_pct numeric(6,4) not null default 0.0100,
  taxa_gateway_pix_fixo numeric(10,2) not null default 1.00,
  -- Custo fixo por pedido aprovado no cartão. Pix não passa por antifraude.
  taxa_antifraude_fixo numeric(10,2) not null default 1.00,
  -- Fallback de frete pra pedido cujo custo real da etiqueta ainda não chegou.
  -- Deixe em 0 se preferir ver "sem custo real" a ver um chute entrando na DRE.
  taxa_frete_estimado numeric(10,2) not null default 0,
  imposto_pct numeric(6,4) not null default 0.0600,
  comissao_influencer_pct numeric(6,4) not null default 0.0500,
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
  -- true = valor digitado na mão nesse mês (não é projeção herdada do mês
  -- anterior). A herança e o rateio pró-rata olham essa flag.
  manually_edited boolean not null default false,
  recorrente boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column monthly_overhead.recorrente is
  'Só para marketing: quando true, a linha é herdada pelos meses seguintes como um gasto fixo. Gasto fixo (is_marketing = false) é sempre herdado, independente desta coluna.';

create index if not exists idx_monthly_overhead_month on monthly_overhead (month);

-- ----------------------------------------------------------------------------
-- TABELA: order_shipping — os dois lados do frete, por pedido.
--
--  * revenue  vem da Shopify (total_shipping_price_set), capturado pelo
--    shopify-webhook / shopify-import-orders. É o que o cliente pagou.
--  * cost     vem do sistema de etiquetas, pela edge function
--    shipping-cost-callback. Pedido sem etiqueta comprada por lá fica com
--    cost nulo e cai no estimado (sale_fee_rates.taxa_frete_estimado).
--  * cost_adjustment é o reajuste de conferência da transportadora (peso ou
--    dimensão reais diferentes do declarado), debitado dias após a postagem.
--
-- Os três entram rateados proporcionalmente ao faturamento entre os itens do
-- mesmo pedido — mesma mecânica da taxa fixa do Pix / antifraude.
-- ----------------------------------------------------------------------------
create table if not exists order_shipping (
  shopify_order_id     bigint primary key,
  order_number         text,
  revenue              numeric(12,2),
  cost                 numeric(12,2),
  cost_adjustment      numeric(12,2),
  revenue_synced_at    timestamptz,
  cost_synced_at       timestamptz,
  adjustment_synced_at timestamptz
);

-- ----------------------------------------------------------------------------
-- FUNÇÃO: carry_forward_fixed_overhead — materializa nos meses seguintes o
-- gasto que se repete (fixo sempre; marketing só quando `recorrente`).
-- Idempotente: não duplica o que já existe no mês.
-- ----------------------------------------------------------------------------
create or replace function carry_forward_fixed_overhead()
returns void
language plpgsql
as $fn$
declare
  m date;
  cur_month date := date_trunc('month', now())::date;
  first_month date;
  ref_month date;
begin
  select min(month) into first_month
  from monthly_overhead
  where not is_marketing or recorrente;
  if first_month is null then
    return;
  end if;

  m := first_month;
  while m <= cur_month loop
    -- último mês anterior a `m` com algum gasto herdável cadastrado
    select max(month) into ref_month
    from monthly_overhead
    where (not is_marketing or recorrente) and month < m;

    if ref_month is not null then
      insert into monthly_overhead (month, category, amount, is_marketing, allocation_method, manually_edited, recorrente)
      select m, ref.category, ref.amount, ref.is_marketing, ref.allocation_method, false, ref.recorrente
      from monthly_overhead ref
      where ref.month = ref_month
        and (not ref.is_marketing or ref.recorrente)
        and not exists (
          -- compara dentro do mesmo balde: "Tráfego pago" de marketing não
          -- colide com um fixo de mesmo nome
          select 1 from monthly_overhead x
          where x.month = m
            and x.category = ref.category
            and x.is_marketing = ref.is_marketing
        );
    end if;

    m := (m + interval '1 month')::date;
  end loop;
end;
$fn$;

grant execute on function carry_forward_fixed_overhead() to authenticated;

-- ----------------------------------------------------------------------------
-- VIEW: monthly_totals — base de rateio. Faturamento LÍQUIDO de cupom.
-- ----------------------------------------------------------------------------
create or replace view monthly_totals as
select
  date_trunc('month', sale_date)::date as month,
  sum(quantity) as units,
  sum(gross_amount - discount_amount) as revenue
from sale_revenue
group by 1;

-- ----------------------------------------------------------------------------
-- VIEW: sale_overhead_allocation — quanto de marketing/fixo cada venda
-- absorve. No mês corrente o gasto herdado é projeção do mês inteiro, então
-- entra proporcional aos dias decorridos — senão a venda do dia 1 carrega o
-- aluguel fechado do mês inteiro e aparece no prejuízo. Valor digitado na mão
-- (`manually_edited`) é dinheiro já gasto e entra inteiro.
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

-- ----------------------------------------------------------------------------
-- VIEW: sale_margin — o cálculo completo, por item de venda.
--
-- net_profit é a SOMA das colunas já arredondadas, e não a fórmula reescrita
-- por inteiro: assim o waterfall da tela fecha no centavo por construção, e
-- não existe o risco de corrigir a conta num lugar e esquecer do outro.
-- ----------------------------------------------------------------------------
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
      + coalesce(fr.sacolinha, 0::numeric) + coalesce(fr.adesivo, 0::numeric)
      + coalesce(pc.outros_acabamentos, 0::numeric)
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

-- ----------------------------------------------------------------------------
-- VIEW: monthly_dre — o mesmo cálculo, somado por mês.
-- ----------------------------------------------------------------------------
create or replace view monthly_dre as
select
  date_trunc('month', sale_date)::date as month,
  sum(gross_amount) as gross_revenue,
  sum(discount_amount) as discount_amount,
  sum(direct_cost) as direct_cost,
  sum(sale_cost) as sale_cost,
  sum(marketing_cost) as marketing_cost,
  sum(fixed_cost) as fixed_cost,
  sum(shipping_revenue) as shipping_revenue,
  sum(shipping_cost) as shipping_cost,
  sum(shipping_adjustment) as shipping_adjustment,
  sum(net_profit) as net_profit
from sale_margin
group by 1;

-- CREATE OR REPLACE VIEW não garante que reloptions (security_invoker)
-- sobrevivam — reforça explicitamente toda vez que a view for recriada,
-- senão a RLS das tabelas de baixo vaza pra qualquer authenticated.
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
as $fn$
  select exists (
    select 1 from admin_emails where email = auth.jwt() ->> 'email'
  );
$fn$;

-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
alter table sale_revenue enable row level security;
alter table product_costs enable row level security;
alter table sale_fee_rates enable row level security;
alter table monthly_overhead enable row level security;
alter table order_shipping enable row level security;

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

drop policy if exists order_shipping_admin_only on order_shipping;
create policy order_shipping_admin_only on order_shipping
  for select using (is_admin_user());

-- sale_revenue e order_shipping nunca recebem insert/update/delete de um
-- client autenticado comum: a sincronização roda com a Service Role, fora
-- do RLS.

-- Deixa os grants explícitos pra não depender de default privilege (o acesso
-- real continua barrado pela RLS das tabelas, porque as views são
-- security_invoker).
grant select on monthly_totals, sale_overhead_allocation, sale_margin, monthly_dre to authenticated;
grant select on monthly_totals, sale_overhead_allocation, sale_margin, monthly_dre to service_role;

notify pgrst, 'reload schema';

-- Preencher com o(s) e-mail(s) que podem administrar este projeto:
-- insert into admin_emails (email) values ('admin@exemplo.com') on conflict (email) do nothing;
