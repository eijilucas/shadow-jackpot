-- ----------------------------------------------------------------------------
-- Corrige o timeout do cron: default do net.http_post é 5s, curto demais
-- pra function paginar contra a API do Melhor Envio (o primeiro backfill
-- levou bem mais que isso). cron.schedule com o mesmo nome substitui o job
-- existente em vez de duplicar.
-- ----------------------------------------------------------------------------
select cron.schedule(
  'melhor-envio-import-shipments',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://xpyqedzrpxfcxdlvvmly.supabase.co/functions/v1/melhor-envio-import-shipments',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'melhorenvio_import_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
