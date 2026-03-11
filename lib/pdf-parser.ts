/**
 * PDF parser: extracts text from PDF files while removing headers,
 * footers, and page numbers, then structures content by chapter.
 * Uses calibre-inspired heuristics for paragraph reconstruction and
 * header/footer detection.
 */

import pdfParse from 'pdf-parse';

export interface PdfData {
  title: string;
  author: string;
  html: string;
}

interface PageText {
  pageNum: number;
  lines: string[];
  yPositions: number[]; // Y coordinate for each line (descending = top of page)
}

/** Normalize whitespace and trim a line. */
function normLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/** Return true if a line looks like a page number (e.g. "1", "- 1 -", "Page 1 of 10"). */
function isPageNumber(line: string): boolean {
  return (
    /^\s*\d+\s*$/.test(line) ||
    /^[-–—\s]*\d+[-–—\s]*$/.test(line) ||
    /^page\s+\d+(\s+of\s+\d+)?$/i.test(line)
  );
}

/** Compute a normalized "fingerprint" for a line, used to detect repeating headers/footers. */
function lineFingerprint(line: string): string {
  return line
    .toLowerCase()
    .replace(/\d+/g, '#')   // replace numbers with placeholder
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect header/footer lines that appear in many pages.
 * Uses calibre-inspired approach: check top and bottom margins of each page.
 * Returns a set of line fingerprints to remove.
 */
function detectRecurringLines(pages: PageText[], threshold = 0.3): Set<string> {
  if (pages.length < 2) return new Set();

  const fingerprintCounts: Map<string, number> = new Map();

  // Examine the first 3 and last 3 lines of each page (where headers/footers appear)
  for (const page of pages) {
    const candidates = new Set<string>();
    const checkCount = Math.min(3, Math.floor(page.lines.length / 2));
    const firstLines = page.lines.slice(0, checkCount);
    const lastLines = page.lines.slice(-checkCount);

    for (const line of [...firstLines, ...lastLines]) {
      if (line.length > 0) {
        const fp = lineFingerprint(line);
        if (fp.length > 1) candidates.add(fp);
      }
    }

    for (const fp of candidates) {
      fingerprintCounts.set(fp, (fingerprintCounts.get(fp) ?? 0) + 1);
    }
  }

  const recurringFPs = new Set<string>();
  for (const [fp, count] of fingerprintCounts.entries()) {
    if (count / pages.length >= threshold) {
      recurringFPs.add(fp);
    }
  }

  return recurringFPs;
}

/** Detect if a line is a chapter heading. */
function isChapterHeading(line: string): { level: number; text: string } | null {
  // Match: "Chapter N", "BAB N", "CHAPTER N", Roman numerals as headings
  const patterns: [RegExp, number][] = [
    [/^(chapter\s+[\divxlc]+[\.:–\s]*.*)/i, 1],
    [/^(bab\s+[\divxlc]+[\.:–\s]*.*)/i, 1],
    [/^(part\s+[\divxlc]+[\.:–\s]*.*)/i, 1],
    [/^(bagian\s+[\divxlc]+[\.:–\s]*.*)/i, 1],
    [/^([IVXivx]+\.\s+\S+.*)/,  2],
    [/^(\d+\.\d*\s+\S+.*)/, 3],
  ];

  for (const [pat, level] of patterns) {
    if (pat.test(line)) {
      return { level, text: line };
    }
  }

  // ALL CAPS line that isn't too long and isn't a page number
  if (
    /^[A-Z\s\d.,;:!?'"-]{3,60}$/.test(line) &&
    line === line.toUpperCase() &&
    line.replace(/\s/g, '').length > 3 &&
    !isPageNumber(line)
  ) {
    return { level: 2, text: line };
  }

  return null;
}

/** Default line spacing in points when no lines are available to compute from. */
const DEFAULT_LINE_SPACING = 14;
/** Maximum gap between adjacent lines to consider for spacing statistics (filters page transitions). */
const MAX_LINE_GAP_FOR_STATS = 100;
/** A Y-position gap larger than this multiple of the median line spacing is treated as a paragraph break. */
const PARAGRAPH_GAP_MULTIPLIER = 1.5;

/**
 * Compute the median line spacing from a flat list of lines with Y positions.
 * Used to detect paragraph breaks (gaps significantly larger than normal line spacing).
 */
function computeMedianLineSpacing(yPositions: number[]): number {
  if (yPositions.length < 2) return DEFAULT_LINE_SPACING;
  const gaps: number[] = [];
  for (let i = 1; i < yPositions.length; i++) {
    const gap = Math.abs(yPositions[i - 1] - yPositions[i]);
    if (gap > 0 && gap < MAX_LINE_GAP_FOR_STATS) gaps.push(gap);
  }
  if (gaps.length === 0) return DEFAULT_LINE_SPACING;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Convert extracted PDF lines to clean HTML using Y-position-based paragraph detection.
 * Uses calibre-inspired heuristics: a gap larger than 1.5x the typical line spacing
 * indicates a paragraph break.
 */
function linesToHtml(lines: string[], yPositions: number[]): string {
  const parts: string[] = [];
  let paragraphLines: string[] = [];

  const medianSpacing = computeMedianLineSpacing(yPositions);
  const paragraphGapThreshold = medianSpacing * PARAGRAPH_GAP_MULTIPLIER;

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      const text = paragraphLines.join(' ').trim();
      if (text) parts.push(`<p>${escapeHtml(text)}</p>`);
      paragraphLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    const heading = isChapterHeading(line);
    if (heading) {
      flushParagraph();
      const tag = `h${heading.level}`;
      parts.push(`<${tag}>${escapeHtml(heading.text)}</${tag}>`);
      continue;
    }

    // Check for a paragraph break using Y-position gap
    if (i > 0 && yPositions[i] !== undefined && yPositions[i - 1] !== undefined) {
      const gap = Math.abs(yPositions[i - 1] - yPositions[i]);
      if (gap > paragraphGapThreshold) {
        flushParagraph();
      }
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  return parts.join('\n');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Text content item from pdfjs. */
interface PdfTextItem {
  str: string;
  transform: number[];
}

/** pdfjs text content structure. */
interface PdfTextContent {
  items: PdfTextItem[];
}

/** Per-page render callback data passed by pdf-parse. */
interface PdfPageData {
  getTextContent: () => Promise<PdfTextContent>;
}

export async function parsePdf(buffer: Buffer, filename?: string): Promise<PdfData> {
  // Collect per-page text
  const pages: PageText[] = [];
  let pageIndex = 0;

  await pdfParse(buffer, {
    pagerender: (pageData: PdfPageData) => {
      return pageData.getTextContent().then((textContent) => {
        const currentPage = pageIndex++;
        // Build lines from text items, grouping by Y position
        const yBuckets: Map<number, string[]> = new Map();

        for (const item of textContent.items) {
          const y = Math.round(item.transform[5]); // Y coordinate
          const text = item.str;
          if (!yBuckets.has(y)) yBuckets.set(y, []);
          yBuckets.get(y)!.push(text);
        }

        // Sort by Y descending (top of page first in PDF coordinate space)
        const sortedYs = Array.from(yBuckets.keys()).sort((a, b) => b - a);
        const lines: string[] = [];
        const yPositions: number[] = [];
        for (const y of sortedYs) {
          const lineText = normLine(yBuckets.get(y)!.join(''));
          if (lineText.length > 0) {
            lines.push(lineText);
            yPositions.push(y);
          }
        }

        pages.push({ pageNum: currentPage, lines, yPositions });
        return ''; // we don't need the default text output
      });
    },
  });

  // Extract metadata from the first parse (use a simple parse for info)
  const basicResult = await pdfParse(buffer);
  const info = basicResult.info ?? {};
  const title = (info.Title as string) || (filename ? filename.replace(/\.pdf$/i, '') : 'Untitled');
  const author = (info.Author as string) || 'Unknown Author';

  if (pages.length === 0) {
    return { title, author, html: '<p>No content found in PDF.</p>' };
  }

  // Detect recurring header/footer fingerprints
  const recurringFPs = detectRecurringLines(pages);

  // Clean each page: remove headers, footers, page numbers
  const cleanedPages: { lines: string[]; yPositions: number[] }[] = pages.map((page) => {
    const filteredLines: string[] = [];
    const filteredYs: number[] = [];
    const checkCount = Math.min(3, Math.floor(page.lines.length / 2));

    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      const fp = lineFingerprint(line);

      // Skip page numbers
      if (isPageNumber(line)) continue;

      // Skip lines matching recurring header/footer patterns at top/bottom margins
      const isTopMargin = i < checkCount;
      const isBottomMargin = i >= page.lines.length - checkCount;
      if ((isTopMargin || isBottomMargin) && recurringFPs.has(fp)) continue;

      filteredLines.push(line);
      filteredYs.push(page.yPositions[i] ?? 0);
    }
    return { lines: filteredLines, yPositions: filteredYs };
  });

  // Merge all lines and Y positions across pages
  const allLines: string[] = [];
  const allYs: number[] = [];
  for (let i = 0; i < cleanedPages.length; i++) {
    allLines.push(...cleanedPages[i].lines);
    allYs.push(...cleanedPages[i].yPositions);
    if (i < cleanedPages.length - 1) {
      // Insert a blank line sentinel between pages (with a large Y gap to force paragraph break)
      allLines.push('');
      allYs.push(0);
    }
  }

  const html = linesToHtml(allLines, allYs);
  return { title, author, html };
}
