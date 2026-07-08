// ─── Supabase ───
// Fill these in with your project's values from Supabase Dashboard →
// Project Settings → API, after running supabase-schema.sql there.
const SUPABASE_URL      = 'https://gcxdbjbeorrmmnfxxweh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Pkbc7HmJYdxWqAqdj_EHqw_Z9tAadZg';

(function () {
  if (typeof window.supabase === 'undefined') {
    console.warn("[Ta'ahud] Supabase SDK not loaded — running in local-only mode");
    return;
  }
  window._supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'taahud.session',
    },
  });
  console.log("[Ta'ahud] Supabase connected ✓");
})();
