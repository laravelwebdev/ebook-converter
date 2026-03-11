/**
 * EPUB parser: reads EPUB files (ZIP archives) and extracts
 * title, author, ordered HTML chapter content, and embedded images.
 * Images are embedded as base64 data URIs in the HTML so they can be
 * included in the output MOBI/AZW3 file.
 */

import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';

export interface EpubData {
  title: string;
  author: string;
  html: string;
}

/** Extract text content of the first matching element, recursively. */
function getFirstText(obj: unknown): string {
  if (!obj) return '';
  if (typeof obj === 'string') return obj.trim();
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const t = getFirstText(item);
      if (t) return t;
    }
    return '';
  }
  if (typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if ('_' in rec) return String(rec['_']).trim();
    for (const key of Object.keys(rec)) {
      if (key.startsWith('$')) continue;
      const t = getFirstText(rec[key]);
      if (t) return t;
    }
  }
  return '';
}

/** Resolve a relative path against a base path (e.g., "OEBPS/content.opf"). */
function resolvePath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1);
  const parts = base.split('/');
  parts.pop(); // remove filename from base
  for (const seg of relative.split('/')) {
    if (seg === '..') {
      if (parts.length > 0) parts.pop(); // guard against over-popping
    } else if (seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** Strip the XML namespace prefix from a tag name. */
function localName(tag: string): string {
  const idx = tag.lastIndexOf(':');
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

/** Convert any XML parsed node to a simple tag-keyed lookup (handles ns prefixes). */
function flattenNS(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[localName(k)] = v;
  }
  return out;
}

/**
 * Iteratively remove a block-level HTML tag (opening + content + closing) until
 * no further matches are found. This handles nested/malformed inputs like
 * `<sc<script>ript>` where a single pass would leave residual tags.
 */
function removeTagIterative(html: string, tag: string): string {
  const blockRe = new RegExp(`<${tag}[\\s\\S]*?<\\/\\s*${tag}\\s*>`, 'gi');
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let prev = '';
  let result = html;
  while (result !== prev) {
    prev = result;
    result = result.replace(blockRe, '').replace(openRe, '');
  }
  return result;
}

/** Replace relative image src attributes with base64 data URIs from imageMap. */
function replaceImageSrcs(
  html: string,
  imageMap: Map<string, string>,
  chapterPath: string
): string {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (_match, pre, src, post) => {
    if (src.startsWith('data:') || src.startsWith('http')) return pre + src + post;
    const resolved = resolvePath(chapterPath, src);
    const dataUri =
      imageMap.get(resolved) ??
      imageMap.get(src) ??
      imageMap.get(src.split('/').pop() ?? '');
    if (dataUri) return pre + dataUri + post;
    return pre + src + post;
  });
}

/** Clean HTML from an EPUB chapter for Kindle compatibility. */
function cleanChapterHtml(
  raw: string,
  imageMap: Map<string, string>,
  chapterPath: string
): string {
  let html = raw;

  // Remove XML declaration and DOCTYPE
  html = html.replace(/<\?xml[^>]*\?>/gi, '');
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Extract body content if present
  html = html.replace(/^[\s\S]*?<body[^>]*>([\s\S]*?)<\/body>[\s\S]*$/i, '$1');

  // Iteratively remove dangerous tags until no more matches
  html = removeTagIterative(html, 'script');
  html = removeTagIterative(html, 'svg');

  // Remove epub:type and namespace attributes
  html = html.replace(/\s+epub:[a-zA-Z-]+="[^"]*"/g, '');
  html = html.replace(/\s+xmlns:[a-zA-Z0-9]+="[^"]*"/g, '');

  // Replace relative image src references with base64 data URIs
  html = replaceImageSrcs(html, imageMap, chapterPath);

  return html.trim();
}

export async function parseEpub(buffer: Buffer): Promise<EpubData> {
  const zip = await JSZip.loadAsync(buffer);

  // 1. Read META-INF/container.xml to find the OPF file path
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('Invalid EPUB: missing META-INF/container.xml');

  const containerObj = await parseStringPromise(containerXml, { explicitArray: true });
  const roots =
    containerObj?.container?.rootfiles?.[0]?.rootfile ??
    containerObj?.['container']?.['rootfiles']?.[0]?.['rootfile'];

  if (!roots || roots.length === 0) throw new Error('Invalid EPUB: no rootfile found');

  const opfPath: string = roots[0]?.['$']?.['full-path'] ?? '';
  if (!opfPath) throw new Error('Invalid EPUB: could not determine OPF path');

  // 2. Parse OPF file for metadata and spine
  const opfXml = await zip.file(opfPath)?.async('text');
  if (!opfXml) throw new Error(`Invalid EPUB: OPF file not found at ${opfPath}`);

  const opf = await parseStringPromise(opfXml, { explicitArray: true, tagNameProcessors: [localName] });
  const pkg = opf?.package ?? opf?.['package'];
  if (!pkg) throw new Error('Invalid EPUB: malformed OPF');

  // Extract metadata
  const metadata = pkg?.metadata?.[0] ?? {};
  const titleRaw = metadata?.title?.[0] ?? metadata?.['dc:title']?.[0] ?? 'Unknown Title';
  const authorRaw = metadata?.creator?.[0] ?? metadata?.['dc:creator']?.[0] ?? 'Unknown Author';

  const title = getFirstText(titleRaw) || 'Unknown Title';
  const author = getFirstText(authorRaw) || 'Unknown Author';

  // Build manifest: id -> href map
  const manifest = pkg?.manifest?.[0]?.item ?? [];
  const idToHref: Record<string, string> = {};

  // Build image map: absolute path -> base64 data URI
  const imageMap = new Map<string, string>();

  for (const item of manifest) {
    const attrs = item?.['$'] ?? {};
    if (attrs.id && attrs.href) {
      idToHref[attrs.id] = resolvePath(opfPath, attrs.href);
    }
    // Extract images and store as base64 data URIs
    const mediaType: string = attrs['media-type'] ?? '';
    if (mediaType.startsWith('image/') && attrs.href) {
      const absPath = resolvePath(opfPath, attrs.href);
      const imageFile = zip.file(absPath);
      if (imageFile) {
        const imageBase64 = await imageFile.async('base64');
        const dataUri = `data:${mediaType};base64,${imageBase64}`;
        // Index by absolute path, relative href, and basename
        imageMap.set(absPath, dataUri);
        imageMap.set(attrs.href, dataUri);
        const basename = absPath.split('/').pop() ?? '';
        if (basename) imageMap.set(basename, dataUri);
      }
    }
  }

  // Build spine order
  const spineItems = pkg?.spine?.[0]?.itemref ?? [];
  const orderedHrefs: string[] = [];
  for (const ref of spineItems) {
    const attrs = ref?.['$'] ?? {};
    const idref: string = attrs.idref ?? '';
    const linear: string = (attrs.linear ?? 'yes').toLowerCase();
    if (linear === 'no') continue;
    const href = idToHref[idref];
    if (href) orderedHrefs.push(href);
  }

  if (orderedHrefs.length === 0) {
    // Fallback: use all HTML/XHTML items in manifest order
    for (const item of manifest) {
      const attrs = item?.['$'] ?? {};
      const mediaType: string = attrs['media-type'] ?? '';
      if (mediaType.includes('html') || mediaType.includes('xhtml')) {
        const href = resolvePath(opfPath, attrs.href ?? '');
        if (href) orderedHrefs.push(href);
      }
    }
  }

  // 3. Extract and concatenate chapter HTML in spine order
  const chapterParts: string[] = [];
  for (const href of orderedHrefs) {
    const file = zip.file(href);
    if (!file) continue;
    const raw = await file.async('text');
    const cleaned = cleanChapterHtml(raw, imageMap, href);
    if (cleaned.trim()) {
      chapterParts.push(`<div class="chapter">\n${cleaned}\n</div>`);
    }
  }

  const html = chapterParts.join('\n\n');
  return { title, author, html };
}
