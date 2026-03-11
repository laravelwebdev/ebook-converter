/**
 * MOBI/AZW3 binary format generator.
 * Generates Kindle-compatible MOBI (MobiPocket) files.
 * The PalmDOC + MOBI6 format is natively supported by all Kindle devices.
 * Images embedded as base64 data URIs in the HTML are extracted and stored
 * as binary image records in the PalmDB file.
 */

interface MobiContent {
  title: string;
  author: string;
  html: string;
}

interface ExtractedImage {
  data: Buffer;
  mimeType: string;
}

/** Number of digits used in Kindle image reference indices (e.g., "0001"). */
const KINDLE_IMAGE_INDEX_WIDTH = 4;

/**
 * Extract all base64 data URI images from HTML, replace each with a
 * kindle:image reference, and return the processed HTML plus image buffers.
 * Kindle uses 1-indexed recindex relative to the first image record.
 */
function extractImages(html: string): { html: string; images: ExtractedImage[] } {
  const images: ExtractedImage[] = [];
  const processed = html.replace(
    /(<img\b[^>]*?)\bsrc="data:(image\/[^;]+);base64,([^"]+)"([^>]*?>)/gi,
    (_match, pre, mimeType, base64Data, post) => {
      const idx = images.length + 1; // 1-indexed
      images.push({
        data: Buffer.from(base64Data, 'base64'),
        mimeType: mimeType.toLowerCase(),
      });
      const recAttr = `src="kindle:image:${String(idx).padStart(KINDLE_IMAGE_INDEX_WIDTH, '0')}"`;
      return `${pre}${recAttr}${post}`;
    }
  );
  return { html: processed, images };
}

/** Convert Unix timestamp to Palm epoch (seconds since Jan 1, 1904). */
function toPalmEpoch(unixMs: number): number {
  return Math.floor(unixMs / 1000) + 2082844800;
}

/** Write a 4-byte big-endian unsigned integer into buf at offset. */
function w32(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt32BE(val >>> 0, offset);
}

/** Write a 2-byte big-endian unsigned integer into buf at offset. */
function w16(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt16BE(val & 0xffff, offset);
}

function buildExthHeader(title: string, author: string): Buffer {
  const writeRecord = (type: number, data: Buffer): Buffer => {
    const rec = Buffer.alloc(8 + data.length);
    w32(rec, 0, type);
    w32(rec, 4, 8 + data.length);
    data.copy(rec, 8);
    return rec;
  };

  const records: Buffer[] = [
    writeRecord(100, Buffer.from(author, 'utf8')),   // author
    writeRecord(503, Buffer.from(title, 'utf8')),    // updated title
  ];

  const recordsData = Buffer.concat(records);
  // EXTH header: "EXTH" + total_length (uint32) + record_count (uint32) + records
  const totalLen = 12 + recordsData.length;
  // Pad to 4-byte boundary
  const paddedLen = Math.ceil(totalLen / 4) * 4;
  const exth = Buffer.alloc(paddedLen, 0);
  exth.write('EXTH', 0, 'ascii');
  w32(exth, 4, paddedLen);
  w32(exth, 8, records.length);
  recordsData.copy(exth, 12);
  return exth;
}

function buildRecord0(
  title: string,
  author: string,
  numTextRecords: number,
  textLength: number,
  firstImageIndex: number
): Buffer {
  const titleBytes = Buffer.from(title, 'utf8');
  const exthHeader = buildExthHeader(title, author);

  // PalmDOC header: 16 bytes
  const palmDoc = Buffer.alloc(16, 0);
  w16(palmDoc, 0, 1);               // compression: none
  w32(palmDoc, 4, textLength);       // text length (uncompressed)
  w16(palmDoc, 8, numTextRecords);   // text record count
  w16(palmDoc, 10, 4096);            // record size

  // MOBI header: 232 bytes
  const mobi = Buffer.alloc(232, 0);
  mobi.write('MOBI', 0, 'ascii');
  w32(mobi, 4, 232);                            // header length
  w32(mobi, 8, 2);                              // type: Mobipocket book
  w32(mobi, 12, 65001);                         // encoding: UTF-8
  w32(mobi, 16, 0xdeadbeef);                    // UID (arbitrary)
  w32(mobi, 20, 6);                             // file version: MOBI6

  // Set unused index pointers to 0xFFFFFFFF
  for (let i = 24; i < 64; i += 4) w32(mobi, i, 0xffffffff);

  // First non-book record number (after text records)
  const firstNonBook = 1 + numTextRecords;
  w32(mobi, 64, firstNonBook);

  // Full name: offset from start of record 0, length
  const fullNameOffset = 16 + 232 + exthHeader.length;
  w32(mobi, 68, fullNameOffset);
  w32(mobi, 72, titleBytes.length);

  w32(mobi, 76, 0x0409);          // locale: English US
  w32(mobi, 88, 6);               // min version
  w32(mobi, 92, firstImageIndex); // first image record index

  // Huff/CDIC: none
  w32(mobi, 96, 0);
  w32(mobi, 100, 0);
  w32(mobi, 104, 0);
  w32(mobi, 108, 0);

  w32(mobi, 112, 0x40);           // EXTH flags: bit 6 = has EXTH

  // DRM: not present
  w32(mobi, 136, 0xffffffff);
  w32(mobi, 140, 0);
  w32(mobi, 144, 0);
  w32(mobi, 148, 0);

  // Content record range
  w16(mobi, 160, 1);
  w16(mobi, 162, numTextRecords);
  w32(mobi, 164, 1);

  // FCIS / FLIS: not present
  w32(mobi, 168, 0xffffffff);
  w32(mobi, 172, 1);
  w32(mobi, 176, 0xffffffff);
  w32(mobi, 180, 1);

  // INDX: not present
  w32(mobi, 200, 0xffffffff);

  // Pad title to 4-byte boundary
  const titlePadLen = Math.ceil(titleBytes.length / 4) * 4;
  const titlePadded = Buffer.alloc(titlePadLen, 0);
  titleBytes.copy(titlePadded, 0);

  return Buffer.concat([palmDoc, mobi, exthHeader, titlePadded]);
}

/**
 * Generate a MOBI binary buffer from HTML content.
 * The resulting file uses .azw3 extension and is readable by all Kindle devices/apps.
 */
export function generateMobi(content: MobiContent): Buffer {
  const { title, author } = content;

  // Extract base64 images from HTML, replacing with kindle:image references
  const { html: processedHtml, images } = extractImages(content.html);

  // Wrap HTML in minimal document structure
  const fullHtml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head>',
    `<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>`,
    `<title>${escapeHtml(title)}</title>`,
    '<style type="text/css">',
    'body { font-family: serif; font-size: 1em; line-height: 1.5; margin: 1em; }',
    'h1, h2, h3 { font-weight: bold; margin-top: 2em; page-break-before: always; }',
    'h1:first-child, h2:first-child, h3:first-child { page-break-before: avoid; }',
    'p { margin: 0.5em 0; text-indent: 1.5em; }',
    'p.noindent { text-indent: 0; }',
    'img { max-width: 100%; }',
    '</style>',
    '</head>',
    '<body>',
    processedHtml,
    '</body>',
    '</html>',
  ].join('\n');

  const htmlBuf = Buffer.from(fullHtml, 'utf8');
  const chunkSize = 4096;
  const textRecords: Buffer[] = [];

  for (let i = 0; i < htmlBuf.length; i += chunkSize) {
    textRecords.push(htmlBuf.subarray(i, Math.min(i + chunkSize, htmlBuf.length)));
  }
  if (textRecords.length === 0) textRecords.push(Buffer.alloc(0));

  // First image record is immediately after text records (record 0 is header, then text records)
  const firstImageIndex = 1 + textRecords.length;

  const record0 = buildRecord0(title, author, textRecords.length, htmlBuf.length, firstImageIndex);

  // Image records (raw image bytes, one record per image)
  const imageRecords: Buffer[] = images.map((img) => img.data);

  const allRecords: Buffer[] = [record0, ...textRecords, ...imageRecords];
  const numRecords = allRecords.length;

  // Palm header: 78 bytes
  // Record list: numRecords * 8 bytes
  // Gap/padding: 2 bytes (standard PalmDB gap)
  const headerSize = 78;
  const listSize = numRecords * 8;
  const gapSize = 2;
  const firstRecordOffset = headerSize + listSize + gapSize;

  const offsets: number[] = [];
  let off = firstRecordOffset;
  for (const rec of allRecords) {
    offsets.push(off);
    off += rec.length;
  }

  // Build PalmDB header (78 bytes)
  const palmHeader = Buffer.alloc(78, 0);
  // Database name: max 31 chars, null-terminated
  const nameAscii = title.replace(/[^\x20-\x7e]/g, '_').substring(0, 31);
  palmHeader.write(nameAscii, 0, 'ascii');
  const now = toPalmEpoch(Date.now());
  w32(palmHeader, 36, now);         // creation time
  w32(palmHeader, 40, now);         // modification time
  palmHeader.write('BOOK', 60, 'ascii');  // type
  palmHeader.write('MOBI', 64, 'ascii');  // creator
  w32(palmHeader, 68, 1);          // unique ID seed
  w16(palmHeader, 76, numRecords); // num records

  // Build record list + 2-byte gap
  const recordList = Buffer.alloc(listSize + gapSize, 0);
  for (let i = 0; i < numRecords; i++) {
    w32(recordList, i * 8, offsets[i]);     // offset
    w32(recordList, i * 8 + 4, i);          // uid = i (attributes = 0)
  }

  return Buffer.concat([palmHeader, recordList, ...allRecords]);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
