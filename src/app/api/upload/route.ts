import { NextRequest, NextResponse } from 'next/server';
import { supabase, STORAGE_BUCKET, DOCUMENTS_TABLE } from '@/lib/supabase';
import { upsertRecords, deleteRecords } from '@/lib/pinecone';
import { liteParse } from '@/lib/liteparse';
import { hashText } from '@/lib/hash';

export const maxDuration = 60; // Vercel serverless max duration

export async function POST(request: NextRequest) {
  try {
    let type: 'pdf' | 'text';
    let content: Buffer | string; // Buffer for PDF file, string for raw text
    let name: string;
    let mode: 'Add' | 'Replace' | 'Delete';
    let rawFileBuffer: Buffer | null = null; // Keep raw buffer for Storage upload

    // Detect content type and parse accordingly
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      // FormData upload (from browser UI)
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      const textContent = formData.get('content') as string | null;
      name = (formData.get('name') as string) || (file?.name || '');
      mode = (formData.get('mode') as 'Add' | 'Replace' | 'Delete') || 'Add';

      if (!name) {
        return NextResponse.json(
          { status: 'Error', error: 'Missing filename (name field or file name)' },
          { status: 400 }
        );
      }

      if (mode === 'Delete') {
        // Delete mode — only need name, no file or content required
        type = 'text'; // placeholder, won't be used
        content = '';  // placeholder, won't be used
        } else if (file) {
        // File upload — determine type from extension
        const ext = name.toLowerCase().split('.').pop() || '';
        if (ext === 'pdf') {
          type = 'pdf';
        } else if (ext === 'txt' || ext === 'md' || ext === 'json') {
          type = 'text';
        } else {
          return NextResponse.json(
            { status: 'Error', error: `Unsupported file format: .${ext}. Supported: PDF, TXT, MD.` },
            { status: 400 }
          );
        }

        const arrayBuffer = await file.arrayBuffer();
        rawFileBuffer = Buffer.from(arrayBuffer);
        content = rawFileBuffer;
      } else if (textContent) {
        // Direct text content
        type = 'text';
        content = textContent;
      } else {
        return NextResponse.json(
          { status: 'Error', error: 'Missing file or text content' },
          { status: 400 }
        );
      }
    } else {
      // JSON upload (programmatic API call)
      const body = await request.json();
      type = body.type;
      content = body.content; // For "text": raw text string; For "pdf": base64-encoded string
      name = body.name;
      mode = body.mode;

      if (!name || !mode) {
        return NextResponse.json(
          { status: 'Error', error: 'Missing required fields: name, mode' },
          { status: 400 }
        );
      }

      // type and content are only required for Add/Replace modes (not Delete)
      if (mode !== 'Delete' && (!type || !content)) {
        return NextResponse.json(
          { status: 'Error', error: 'Missing required fields for Add/Replace: type, content' },
          { status: 400 }
        );
      }

      // For PDF JSON uploads, keep base64 string for Storage upload later
      if (type === 'pdf' && typeof content === 'string') {
        rawFileBuffer = Buffer.from(content, 'base64');
      }
    }

    // Validate mode
    if (!['Add', 'Replace', 'Delete'].includes(mode)) {
      return NextResponse.json(
        { status: 'Error', error: 'Invalid mode. Must be: Add, Replace, or Delete' },
        { status: 400 }
      );
    }

    // =================== DELETE MODE ===================
    if (mode === 'Delete') {
      const { data: existing } = await supabase
        .from(DOCUMENTS_TABLE)
        .select('filename, storage_path')
        .eq('filename', name)
        .single();

      if (!existing) {
        return NextResponse.json({ status: 'Not found' });
      }

      // Remove from Storage if path exists
      if (existing.storage_path) {
        await supabase.storage
          .from(STORAGE_BUCKET)
          .remove([existing.storage_path]);
      }

      // Remove from Pinecone
      await deleteRecords(name);

      // Remove from DB
      await supabase
        .from(DOCUMENTS_TABLE)
        .delete()
        .eq('filename', name);

      return NextResponse.json({ status: 'Deleted' });
    }

    // =================== PARSE TEXT ===================
    let text: string;
    let parsePages: number | undefined;
    try {
      const parsed = await liteParse(content, type, name);
      if (!parsed.success) {
        return NextResponse.json(
          { status: 'Error', error: `LiteParse failed: ${parsed.error}` },
          { status: 400 }
        );
      }
      text = parsed.text;
      parsePages = parsed.pages;
    } catch (error: any) {
      return NextResponse.json(
        { status: 'Error', error: `LiteParse failed: ${error.message}` },
        { status: 500 }
      );
    }

    if (!text || text.trim().length === 0) {
      return NextResponse.json(
        { status: 'Error', error: 'No text content extracted from the document' },
        { status: 400 }
      );
    }

    // =================== COMPUTE SHA256 ===================
    const sha256 = hashText(text);

    // =================== STEP 1: DB FILENAME CHECK ===================
    const { data: existing, error: dbError } = await supabase
      .from(DOCUMENTS_TABLE)
      .select('filename, sha256, storage_path')
      .eq('filename', name)
      .single();

    if (dbError && dbError.code !== 'PGRST116') {
      // PGRST116 = no rows returned, which is fine
      return NextResponse.json(
        { status: 'Error', error: `DB lookup failed: ${dbError.message}` },
        { status: 500 }
      );
    }

    // Prepare the buffer for Storage upload
    const storageBuffer = rawFileBuffer;

    // =================== REPLACE MODE ===================
    if (mode === 'Replace') {
      if (!existing) {
        return await insertNewDocument(name, sha256, type, storageBuffer, text, parsePages);
      }

      if (existing.sha256 === sha256) {
        return NextResponse.json({ status: 'Skipped', reason: 'Same content' });
      }

      return await updateExistingDocument(name, sha256, type, storageBuffer, text, parsePages);
    }

    // =================== ADD MODE ===================
    if (mode === 'Add') {
      if (!existing) {
        // No record — check for cross-filename sha256 match
        const { data: crossMatch } = await supabase
          .from(DOCUMENTS_TABLE)
          .select('filename')
          .eq('sha256', sha256)
          .neq('filename', name)
          .limit(1)
          .single();

        if (crossMatch) {
          return NextResponse.json({
            status: 'Skipped',
            reason: `Content already exists as ${crossMatch.filename}`,
          });
        }

        return await insertNewDocument(name, sha256, type, storageBuffer, text, parsePages);
      }

      // Record exists
      if (existing.sha256 === sha256) {
        return NextResponse.json({ status: 'Skipped', reason: 'Same content' });
      }

      return await updateExistingDocument(name, sha256, type, storageBuffer, text, parsePages);
    }

    return NextResponse.json({ status: 'Error', error: 'Unhandled mode' }, { status: 500 });
  } catch (error: any) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { status: 'Error', error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

// =================== HELPER FUNCTIONS ===================

/**
 * Upload PDF to Supabase Storage if type is "pdf".
 * type now only controls Storage, not parsing.
 */
async function uploadToStorage(
  name: string,
  type: 'pdf' | 'text',
  buffer: Buffer | null
): Promise<string | null> {
  if (type !== 'pdf' || !buffer) return null;

  const storagePath = name;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  return storagePath;
}

/**
 * Insert a brand-new document record + storage + pinecone
 */
async function insertNewDocument(
  name: string,
  sha256: string,
  type: 'pdf' | 'text',
  buffer: Buffer | null,
  text: string,
  parsePages?: number
): Promise<NextResponse> {
  // Upload to Storage
  let storagePath: string | null = null;
  try {
    storagePath = await uploadToStorage(name, type, buffer);
  } catch (error: any) {
    return NextResponse.json(
      { status: 'Error', error: error.message },
      { status: 500 }
    );
  }

  // Upsert to Pinecone
  let pineconeResult;
  try {
    pineconeResult = await upsertRecords(text, name);
  } catch (error: any) {
    return NextResponse.json(
      { status: 'Error', error: `Pinecone upsert failed: ${error.message}` },
      { status: 500 }
    );
  }

  // Insert into DB (commit point)
  const { error: insertError } = await supabase
    .from(DOCUMENTS_TABLE)
    .insert({
      filename: name,
      sha256,
      storage_path: storagePath,
      updated_at: new Date().toISOString(),
    });

  if (insertError) {
    return NextResponse.json(
      { status: 'Error', error: `DB insert failed: ${insertError.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: 'Added',
    chunks: pineconeResult.chunks,
    pages: parsePages,
  });
}

/**
 * Update an existing document record + storage + pinecone
 */
async function updateExistingDocument(
  name: string,
  sha256: string,
  type: 'pdf' | 'text',
  buffer: Buffer | null,
  text: string,
  parsePages?: number
): Promise<NextResponse> {
  // Upload to Storage
  let storagePath: string | null = null;
  try {
    storagePath = await uploadToStorage(name, type, buffer);
  } catch (error: any) {
    return NextResponse.json(
      { status: 'Error', error: error.message },
      { status: 500 }
    );
  }

  // Delete old Pinecone records + upsert new ones (upsertRecords handles deleteMany internally)
  let pineconeResult;
  try {
    pineconeResult = await upsertRecords(text, name);
  } catch (error: any) {
    return NextResponse.json(
      { status: 'Error', error: `Pinecone upsert failed: ${error.message}` },
      { status: 500 }
    );
  }

  // Update DB (commit point)
  const { error: updateError } = await supabase
    .from(DOCUMENTS_TABLE)
    .update({
      sha256,
      storage_path: storagePath,
      updated_at: new Date().toISOString(),
    })
    .eq('filename', name);

  if (updateError) {
    return NextResponse.json(
      { status: 'Error', error: `DB update failed: ${updateError.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: 'Updated',
    chunks: pineconeResult.chunks,
    pages: parsePages,
  });
}
