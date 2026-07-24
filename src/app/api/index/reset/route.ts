import { NextResponse } from 'next/server';
import { pineconeIndex } from '@/lib/pinecone';

export async function DELETE() {
  try {
    await pineconeIndex.deleteAll();
    return NextResponse.json({ status: 'Index reset complete' });
  } catch (error: any) {
    if (error.status === 404) {
      return NextResponse.json({ status: 'Index reset complete' });
    }
    return NextResponse.json(
      { status: 'Error', error: error.message },
      { status: 500 }
    );
  }
}