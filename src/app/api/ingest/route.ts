import { NextRequest, NextResponse } from 'next/server';
import { upsertRecords } from '@/lib/pinecone';
import { chunkText } from '@/lib/chunking';
import { supabase, DOCUMENTS_TABLE } from '@/lib/supabase';
import { hashText } from '@/lib/hash';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { content, filename, metadata } = body;

    if (!content || !filename) {
      return NextResponse.json(
        { status: 'Error', error: 'content and filename are required' },
        { status: 400 }
      );
    }

    const chunkResult = chunkText(content);

    if (chunkResult.chunks.length === 0) {
      return NextResponse.json(
        { status: 'Error', error: 'No chunks generated from content' },
        { status: 400 }
      );
    }

    const fullMetadata = {
      filename,
      doc_type: metadata?.doc_type || 'unknown',
      project: metadata?.project || 'default',
      version: metadata?.version || '1.0',
      uploaded_at: Date.now(),
    };

    const result = await upsertRecords(content, filename, fullMetadata);

    // Also insert into Supabase documents table for source validation
    const sha256 = hashText(content);
    const { error: insertError } = await supabase
      .from(DOCUMENTS_TABLE)
      .upsert({
        filename,
        sha256,
        storage_path: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'filename' });

    if (insertError) {
      return NextResponse.json(
        { status: 'Error', error: `DB insert failed: ${insertError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      status: 'success',
      chunksIndexed: result.chunks,
      recordsFound: chunkResult.recordsFound,
    });
  } catch (error: any) {
    return NextResponse.json(
      { status: 'Error', error: error.message },
      { status: 500 }
    );
  }
}