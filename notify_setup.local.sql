-- Run this once in the Supabase SQL Editor AFTER you have:
--   1. Deployed the `notify` Edge Function (supabase functions deploy notify --no-verify-jwt)
--   2. Set its secrets (MAILGUN_API_KEY, MAILGUN_DOMAIN, NOTIFY_EMAILS, CRON_SECRET)
-- See the deployment commands shared alongside this file for the exact CLI steps.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Stores the same CRON_SECRET value you set as an Edge Function secret, so the cron job
-- can prove to the function that the call came from pg_cron and not a random visitor.
-- Replace fa9b582e9b9508552d9e95e7bd4a15cbafc3a430b9cf5218 below with the value you also passed to `supabase secrets set`.
select vault.create_secret(
  'fa9b582e9b9508552d9e95e7bd4a15cbafc3a430b9cf5218',
  'cron_secret',
  'Shared secret the notify Edge Function checks for in the x-cron-secret header'
);

-- Re-runnable: drop any existing schedule with the same name before recreating it.
select cron.unschedule(jobid) from cron.job where jobname = 'trade-expiry-daily';
select cron.unschedule(jobid) from cron.job where jobname = 'trade-monthly-digest';

-- Daily: alert on any open trade whose target date has passed and hasn't been notified yet.
select cron.schedule(
  'trade-expiry-daily',
  '30 3 * * *', -- 03:30 UTC every day
  $$
  select net.http_post(
    url := 'https://pxjryedxetccuxqclbjz.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('type', 'expiry')
  );
  $$
);

-- Monthly: a digest of all trades and investments, on the 1st of each month.
select cron.schedule(
  'trade-monthly-digest',
  '0 6 1 * *', -- 06:00 UTC on day 1 of every month
  $$
  select net.http_post(
    url := 'https://pxjryedxetccuxqclbjz.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('type', 'monthly')
  );
  $$
);

-- To check the schedules: select * from cron.job;
-- To check recent runs:   select * from cron.job_run_details order by start_time desc limit 20;
