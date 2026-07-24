import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Track whether Supabase is actually configured. When false, the query
// pipeline skips source validation and trusts all Pinecone hits — useful
// for local dev or when only OpenCode + Pinecone keys are available.
export const supabaseConfigured = !!(supabaseUrl && serviceRoleKey);

if (!supabaseConfigured) {
  console.warn('[Supabase] NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — source validation will be skipped (all Pinecone hits trusted)');
}

// Server-side client with service_role (bypasses RLS).
// Uses placeholder URL/key when not configured so the client constructor
// doesn't throw — but supabaseConfigured flag gates actual usage.
export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', serviceRoleKey || 'placeholder', {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Storage bucket name
export const STORAGE_BUCKET = 'documents';

// Documents table name
export const DOCUMENTS_TABLE = 'documents';
