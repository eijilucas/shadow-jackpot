-- Dados de exemplo para rodar o projeto localmente antes da sincronização
-- com a Shopify de verdade.

insert into product_costs (product_name, tecido, estampa, costura, outros_acabamentos) values
  ('Moletom Oversized', 61.00, 16.00, 10.50, 2.00),
  ('Camiseta Regular', 18.00, 6.50, 2.50, 0.50);

update sale_fee_rates set
  taxa_shopify_pct = 0.0290,
  taxa_gateway_cartao_pct = 0.0500,
  taxa_gateway_pix_pct = 0.0100,
  taxa_gateway_pix_fixo = 1.00,
  imposto_pct = 0.0600,
  comissao_influencer_pct = 0.0500,
  desconto_medio_pct = 0,
  sacolinha = 1.00,
  adesivo = 0.50
where id = 1;

insert into monthly_overhead (month, category, amount, is_marketing, allocation_method) values
  ('2026-08-01', 'Tráfego pago', 800.00, true, 'per_revenue'),
  ('2026-08-01', 'Plataforma / domínio', 150.00, false, 'per_unit');
