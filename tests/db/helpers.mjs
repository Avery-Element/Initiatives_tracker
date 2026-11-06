// Shared helpers for the PGlite database tests.

// Minimal stand-ins for what Supabase provides: API roles, auth.users, auth.uid()/jwt()/role(),
// and the default privileges Supabase grants on public tables and functions.
export async function setupSupabaseStubs(db) {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (
      id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
      last_sign_in_at timestamptz, created_at timestamptz default now()
    );
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
}

// Runs one statement the way a PostgREST request would: as role "authenticated" with the
// user's JWT claims set (or as "anon" when user is null). Returns { rows, affected } or { error }.
export async function asUser(db, user, sql, params) {
  await db.exec('begin');
  try {
    if (user) {
      await db.query(
        `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true),
                set_config('request.jwt.claim.role', 'authenticated', true)`,
        [user.id, JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
      await db.exec('set local role authenticated');
    } else {
      await db.exec('set local role anon');
    }
    const res = await db.query(sql, params);
    await db.exec('commit');
    return { rows: res.rows, affected: res.affectedRows };
  } catch (e) {
    await db.exec('rollback');
    return { error: e.message };
  }
}

export function makeChecker() {
  let pass = 0, fail = 0;
  return {
    ok(cond, msg, extra) {
      if (cond) { pass++; console.log('  ok  ', msg); }
      else { fail++; console.log('  FAIL', msg, extra ?? ''); }
    },
    done() {
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    },
  };
}
