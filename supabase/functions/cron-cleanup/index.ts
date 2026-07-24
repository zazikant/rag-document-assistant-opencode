// Supabase Edge Function: cron-cleanup
// Hourly cron job that removes orphaned Storage files (files in bucket but not in DB).
// JWT is disabled — this function is invoked by Supabase cron, not by users.

import { createClient } from "npm:@supabase/supabase-js@2";

const STORAGE_BUCKET = "documents";
const DOCUMENTS_TABLE = "documents";
const ORPHAN_AGE_MS = 60 * 60 * 1000; // 1 hour

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ error: "Missing env vars" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Step 1: Get all filenames from DB
    const { data: dbDocs, error: dbError } = await supabase
      .from(DOCUMENTS_TABLE)
      .select("filename");

    if (dbError) {
      return new Response(
        JSON.stringify({ error: `DB query failed: ${dbError.message}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const dbFilenames = new Set((dbDocs || []).map((d: { filename: string }) => d.filename));

    // Step 2: List all files in Storage bucket
    const { data: storageFiles, error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list();

    if (storageError) {
      return new Response(
        JSON.stringify({ error: `Storage list failed: ${storageError.message}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 3: Find orphaned files older than 1h
    const now = Date.now();
    const orphanedFiles: string[] = [];

    for (const file of (storageFiles || [])) {
      if (!dbFilenames.has(file.name)) {
        const createdAt = new Date(file.created_at).getTime();
        if (now - createdAt > ORPHAN_AGE_MS) {
          orphanedFiles.push(file.name);
        }
      }
    }

    // Step 4: Remove orphaned files
    let removed = 0;
    if (orphanedFiles.length > 0) {
      const { error: removeError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove(orphanedFiles);

      if (removeError) {
        return new Response(
          JSON.stringify({ error: `Storage remove failed: ${removeError.message}` }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      removed = orphanedFiles.length;
    }

    return new Response(
      JSON.stringify({
        status: "success",
        total_storage_files: (storageFiles || []).length,
        db_filenames: dbFilenames.size,
        orphaned_found: orphanedFiles.length,
        orphaned_removed: removed,
        removed_files: orphanedFiles,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
