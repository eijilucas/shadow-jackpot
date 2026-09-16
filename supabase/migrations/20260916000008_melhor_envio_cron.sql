-- ----------------------------------------------------------------------------
-- Agenda a importação de etiquetas do Melhor Envio de 6 em 6 horas —
-- antes disso era só manual (curl com o ADMIN_IMPORT_SECRET).
--
-- O secret usado no header Authorization NÃO fica nesta migration (o
-- repositório é público no GitHub) — fica no Vault do Supabase, guardado
-- à parte por um comando que não entra no controle de versão. Se o Vault
-- ainda não tiver o segredo 'melhorenvio_import_secret' quando este cron
-- rodar, a chamada vai falhar com 401 até alguém rodar:
--   select vault.create_secret('<o mesmo valor do ADMIN_IMPORT_SECRET>', 'melhorenvio_import_secret');
-- ----------------------------------------------------------------------------
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

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
    -- default é 5s — pouco pro import paginar contra a API do Melhor Envio.
    timeout_milliseconds := 60000
  );
  $$
);
