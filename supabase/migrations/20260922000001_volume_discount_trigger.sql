-- ----------------------------------------------------------------------------
-- Automatiza a régua "mais de 25 vendas lifetime → custo cai de R$115 pra
-- R$69" — até agora era um UPDATE manual toda vez que alguém reparava que
-- uma peça tinha passado do volume (e um bug real: Touka/Rize/Gaara/Guts
-- foram marcadas erradas porque a régua nunca foi checada peça por peça
-- contra o histórico real).
--
-- Roda como trigger em sale_revenue: toda venda nova (webhook ou import)
-- recalcula quantas unidades daquela peça já venderam no total e, se
-- passar de 25, baixa o custo. Só mexe se o custo ATUAL da peça é
-- exatamente R$115 (o "base") — se o admin já personalizou pra outro
-- valor, o trigger não sobrescreve.
-- ----------------------------------------------------------------------------
create or replace function apply_volume_discount()
returns trigger
language plpgsql
as $fn$
declare
  total_units numeric;
  current_total numeric;
begin
  select coalesce(sum(quantity), 0) into total_units
  from sale_revenue
  where shopify_product_id = new.shopify_product_id;

  if total_units > 25 then
    select (tecido + estampa + costura + fotolito + gravacao_tela + corte)
      into current_total
    from product_costs
    where shopify_product_id = new.shopify_product_id;

    if current_total = 115.00 then
      update product_costs
      set tecido = 11.50, estampa = 11.50, costura = 11.50,
          fotolito = 11.50, gravacao_tela = 11.50, corte = 11.50,
          updated_at = now()
      where shopify_product_id = new.shopify_product_id;
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists sale_revenue_apply_volume_discount on sale_revenue;
create trigger sale_revenue_apply_volume_discount
after insert or update on sale_revenue
for each row
execute function apply_volume_discount();
