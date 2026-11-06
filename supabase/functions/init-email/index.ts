// Supabase Edge Function: sends the Initiatives Tracker's queued email (weekly digest,
// reminders, assignment notices, tests) through Resend.
//
// Invoked by init_fire_outbox() (pg_net): from the hourly pg_cron tick, after an assignment,
// and from the Admin → Email buttons. The request body is ignored. The function only sends rows
// the database has already queued in init_outbox, to the recipients stored on each row, so
// calling it can't send anything else.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets, or `npx supabase secrets set`):
//   RESEND_API_KEY  Resend API key (resend.com → API Keys; "Sending access" is enough).
//                   Shipping's ship-alerts function uses the same secret name, so if it's
//                   already set for the project, nothing to do.
//   INIT_EMAIL_FROM sender, e.g. "Element Initiatives <initiatives@yourdomain.com>". Its domain
//                   must be verified in Resend. Falls back to ALERT_FROM if unset.
//   INIT_REPLY_TO   optional reply-to address (e.g. avery@elementcontract.com)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Deploy:  npx supabase functions deploy init-email --project-ref rxibmtzsnlwxhapktkzt

import { createClient } from 'npm:@supabase/supabase-js@2';
import { render } from './render.ts';

type Row = { key: string; kind: string; recipients: string[]; subject: string; payload: Record<string, unknown> };

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } });
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('INIT_EMAIL_FROM') || Deno.env.get('ALERT_FROM');
  const replyTo = Deno.env.get('INIT_REPLY_TO');

  const { data, error } = await db.rpc('init_outbox_claim');
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  let sent = 0;
  for (const row of (data ?? []) as Row[]) {
    let problem: string | null = null;
    if (!apiKey || !from) problem = 'RESEND_API_KEY / INIT_EMAIL_FROM secrets are not set';
    else if (!row.recipients?.length) problem = 'no recipients';
    else {
      try {
        const { html, text } = render(row.kind, row.payload);
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': row.key },
          body: JSON.stringify({ from, to: row.recipients, subject: row.subject, html, text,
                                 ...(replyTo ? { reply_to: replyTo } : {}) }),
        });
        if (!res.ok) problem = `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`;
      } catch (e) {
        problem = `Send failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const { error: markErr } = await db.rpc('init_outbox_result', { p_key: row.key, p_error: problem });
    if (markErr) console.error('could not record result:', markErr);
    if (!problem) sent++;
  }
  return Response.json({ ok: true, claimed: (data ?? []).length, sent });
});
