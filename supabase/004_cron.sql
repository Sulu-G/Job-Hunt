-- Feed schedule (UTC): pull boards every 3h at :17, re-check links every 4h at :43
select cron.schedule('jobhunt-ingest', '17 */3 * * *', $$
  select net.http_post(url := 'https://lqqzfissbdvsoapmplcv.supabase.co/functions/v1/jobs?mode=ingest',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='jobhunt_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000); $$);
select cron.schedule('jobhunt-verify', '43 */4 * * *', $$
  select net.http_post(url := 'https://lqqzfissbdvsoapmplcv.supabase.co/functions/v1/jobs?mode=verify',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='jobhunt_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000); $$);
