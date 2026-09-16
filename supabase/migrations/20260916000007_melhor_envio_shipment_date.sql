-- ----------------------------------------------------------------------------
-- Adiciona a data real da etiqueta (paid_at/created_at no Melhor Envio) —
-- sem isso, "mais recente" na tela de conferência só refletia quando a
-- gente importou (todo mundo quase no mesmo segundo, no import em lote),
-- não quando a etiqueta foi comprada de verdade.
-- ----------------------------------------------------------------------------
alter table melhor_envio_shipments add column if not exists shipment_date timestamptz;
