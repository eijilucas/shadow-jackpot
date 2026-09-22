-- ----------------------------------------------------------------------------
-- Guarda nome/CEP do destinatário em order_shipping — sem isso não dá pra
-- casar automaticamente uma etiqueta do Melhor Envio (que não tem
-- referência ao pedido Shopify) com o pedido certo. Até agora isso só
-- existia buscando na hora, direto na API da Shopify, num script avulso.
-- ----------------------------------------------------------------------------
alter table order_shipping add column if not exists recipient_name text;
alter table order_shipping add column if not exists recipient_zipcode text;
