import { NextResponse } from 'next/server';
import { supabase, DOCUMENTS_TABLE } from '@/lib/supabase';

/**
 * GET /api/documents — List all documents in the DB
 */
export async function GET() {
  try {
    const { data, error } = await supabase
      .from(DOCUMENTS_TABLE)
      .select('filename, sha256, storage_path, created_at, updated_at')
      .order('updated_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { status: 'Error', error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ documents: data || [] });
  } catch (error: any) {
    return NextResponse.json(
      { status: 'Error', error: error.message },
      { status: 500 }
    );
  }
}
