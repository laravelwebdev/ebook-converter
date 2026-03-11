import { NextRequest, NextResponse } from 'next/server';
import { parseEpub } from '@/lib/epub-parser';
import { parsePdf } from '@/lib/pdf-parser';
import { generateMobi } from '@/lib/mobi-generator';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Maximum allowed upload size: 50 MB */
const MAX_SIZE = 50 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 50 MB)' }, { status: 413 });
    }

    const filename = file.name.toLowerCase();
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let mobiData: { title: string; author: string; html: string };

    if (filename.endsWith('.epub')) {
      mobiData = await parseEpub(buffer);
    } else if (filename.endsWith('.pdf')) {
      mobiData = await parsePdf(buffer, file.name);
    } else {
      return NextResponse.json(
        { error: 'Unsupported file type. Please upload a PDF or EPUB file.' },
        { status: 400 }
      );
    }

    const mobiBuffer = generateMobi(mobiData);
    const outputFilename = file.name.replace(/\.(epub|pdf)$/i, '.azw3');

    return new NextResponse(new Uint8Array(mobiBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${outputFilename}"`,
        'Content-Length': String(mobiBuffer.length),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Conversion failed';
    console.error('[convert] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
