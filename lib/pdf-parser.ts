/**
 * PDF parser: extracts text from PDF files while removing headers,
 * footers, and page numbers, then structures content by chapter.
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
 * Returns a set of line fingerprints to remove.
 */
function detectRecurringLines(pages: PageText[], threshold = 0.4): Set<string> {
  if (pages.length < 3) return new Set();

  const fingerprintCounts: Map<string, number> = new Map();
  const fingerprintExamples: Map<string, string> = new Map();

  // Only examine the first 2 and last 2 lines of each page (where headers/footers appear)
  for (const page of pages) {
    const candidates = new Set<string>();
    const firstLines = page.lines.slice(0, 2);
    const lastLines = page.lines.slice(-2);

    for (const line of [...firstLines, ...lastLines]) {
      if (line.length > 0) {
        const fp = lineFingerprint(line);
        if (fp.length > 1) candidates.add(fp); // skip trivially short lines
        fingerprintExamples.set(fp, line);
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

/** Convert extracted PDF lines to clean HTML. */
function linesToHtml(lines: string[]): string {
  const parts: string[] = [];
  let inParagraph = false;
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      const text = paragraphLines.join(' ').trim();
      if (text) parts.push(`<p>${escapeHtml(text)}</p>`);
      paragraphLines = [];
      inParagraph = false;
    }
  };

  for (const line of lines) {
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

    // Detect likely paragraph ends (line ends with ., ?, !, or is short relative to typical line)
    paragraphLines.push(line);
    inParagraph = true;

    const endsWithPunctuation = /[.?!:;]$/.test(line);
    const isShortLine = line.length < 40;

    if (endsWithPunctuation || (isShortLine && paragraphLines.length > 0)) {
      flushParagraph();
    }
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
        for (const y of sortedYs) {
          const lineText = normLine(yBuckets.get(y)!.join(''));
          if (lineText.length > 0) lines.push(lineText);
        }

        pages.push({ pageNum: currentPage, lines });
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
  const cleanedPages: string[][] = pages.map((page) => {
    const filtered: string[] = [];
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      const fp = lineFingerprint(line);

      // Skip page numbers
      if (isPageNumber(line)) continue;

      // Skip lines matching recurring header/footer patterns
      // (check first 2 and last 2 positions)
      const isFirstOrLast = i < 2 || i >= page.lines.length - 2;
      if (isFirstOrLast && recurringFPs.has(fp)) continue;

      filtered.push(line);
    }
    return filtered;
  });

  // Merge all lines and convert to HTML
  const allLines: string[] = [];
  for (let i = 0; i < cleanedPages.length; i++) {
    allLines.push(...cleanedPages[i]);
    if (i < cleanedPages.length - 1) allLines.push(''); // blank line between pages
  }

  const html = linesToHtml(allLines);
  return { title, author, html };
}
