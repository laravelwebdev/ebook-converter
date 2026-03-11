'use client';

import React, { useState, useCallback, useRef } from 'react';

type ConversionState = 'idle' | 'uploading' | 'converting' | 'done' | 'error';

interface ConversionResult {
  filename: string;
  blob: Blob;
  originalName: string;
  originalSize: number;
  convertedSize: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ type }: { type: 'epub' | 'pdf' | 'azw3' | 'default' }) {
  const colors: Record<string, string> = {
    epub: '#8b5cf6',
    pdf: '#ef4444',
    azw3: '#22c55e',
    default: '#a1a1aa',
  };
  const labels: Record<string, string> = {
    epub: 'EPUB',
    pdf: 'PDF',
    azw3: 'AZW3',
    default: 'FILE',
  };
  const color = colors[type] ?? colors.default;
  const label = labels[type] ?? labels.default;

  return (
    <div
      style={{ borderColor: color, color }}
      className="w-12 h-14 rounded-lg border-2 flex flex-col items-center justify-center gap-0.5 shrink-0"
    >
      <div className="text-[9px] font-semibold leading-none">{label}</div>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5">
        <path d="M4 4h9l5 5v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
        <polyline points="13 4 13 9 18 9" />
      </svg>
    </div>
  );
}

function getFileType(name: string): 'epub' | 'pdf' | 'azw3' | 'default' {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'epub') return 'epub';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'azw3' || ext === 'mobi') return 'azw3';
  return 'default';
}

export default function Home() {
  const [state, setState] = useState<ConversionState>('idle');
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<ConversionResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setState('idle');
    setSelectedFile(null);
    setProgress(0);
    setErrorMessage('');
    setResult(null);
  }, []);

  const startConversion = useCallback(async (file: File) => {
    setSelectedFile(file);
    setState('uploading');
    setProgress(10);
    setResult(null);
    setErrorMessage('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      setState('converting');
      setProgress(40);

      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      setProgress(90);

      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Conversion failed' }));
        throw new Error(json.error ?? 'Conversion failed');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const outputFilename = match ? match[1] : file.name.replace(/\.(epub|pdf)$/i, '.azw3');

      setResult({
        filename: outputFilename,
        blob,
        originalName: file.name,
        originalSize: file.size,
        convertedSize: blob.size,
      });
      setProgress(100);
      setState('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
      setErrorMessage(msg);
      setState('error');
    }
  }, []);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      const name = file.name.toLowerCase();
      if (!name.endsWith('.epub') && !name.endsWith('.pdf')) {
        setErrorMessage('Please upload a PDF or EPUB file.');
        setState('error');
        return;
      }
      startConversion(file);
    },
    [startConversion]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleFiles(e.target.files);
      // Reset the input value so the same file can be re-selected after an error or new attempt
      e.target.value = '';
    },
    [handleFiles]
  );

  const downloadResult = useCallback(() => {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [result]);

  const isProcessing = state === 'uploading' || state === 'converting';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header className="border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--accent)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold leading-none" style={{ color: 'var(--text)' }}>
              Ebook Converter
            </h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              PDF & EPUB → AZW3 (Kindle)
            </p>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-6 py-12 flex flex-col gap-8">
        {/* Hero */}
        <div className="text-center">
          <h2 className="text-3xl font-light tracking-tight" style={{ color: 'var(--text)' }}>
            Convert your ebooks for{' '}
            <span style={{ color: 'var(--accent-light)' }}>Kindle</span>
          </h2>
          <p className="mt-3 text-sm max-w-xl mx-auto" style={{ color: 'var(--text-muted)' }}>
            Upload a PDF or EPUB and get an AZW3 file ready for your Kindle device. PDF conversion
            automatically removes headers, footers, and page numbers. Your files are never stored.
          </p>
        </div>

        {/* Drop zone */}
        {(state === 'idle' || state === 'error') && (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={[
              'relative rounded-2xl border-2 border-dashed cursor-pointer',
              'flex flex-col items-center justify-center gap-4 py-16 px-8',
              'transition-all duration-200',
              dragOver ? 'drop-zone-active' : '',
            ].join(' ')}
            style={{
              borderColor: dragOver ? 'var(--accent)' : 'var(--border)',
              background: dragOver ? 'rgba(139,92,246,0.06)' : 'var(--surface)',
            }}
            role="button"
            tabIndex={0}
            aria-label="Upload file"
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".epub,.pdf"
              className="hidden"
              onChange={handleInputChange}
            />

            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--surface-2)' }}
            >
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent-light)"
                strokeWidth="1.5"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>

            <div className="text-center">
              <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                Drop your file here, or{' '}
                <span style={{ color: 'var(--accent-light)' }}>browse</span>
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Supports PDF and EPUB files up to 50 MB
              </p>
            </div>

            {/* Format badges */}
            <div className="flex gap-2 mt-2">
              {(['PDF', 'EPUB'] as const).map((fmt) => (
                <span
                  key={fmt}
                  className="px-3 py-1 rounded-full text-xs font-medium"
                  style={{
                    background: 'var(--surface-2)',
                    color: 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {fmt}
                </span>
              ))}
              <span
                className="px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1"
                style={{
                  background: 'rgba(139,92,246,0.15)',
                  color: 'var(--accent-light)',
                  border: '1px solid rgba(139,92,246,0.3)',
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                AZW3
              </span>
            </div>
          </div>
        )}

        {/* Error state */}
        {state === 'error' && (
          <div
            className="rounded-xl p-4 flex items-start gap-3"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--error)"
              strokeWidth="2"
              className="mt-0.5 shrink-0"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--error)' }}>
                Conversion failed
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {errorMessage}
              </p>
            </div>
          </div>
        )}

        {/* Processing state */}
        {isProcessing && selectedFile && (
          <div
            className="rounded-2xl p-6 flex flex-col gap-5"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-4">
              <FileIcon type={getFileType(selectedFile.name)} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
                  {selectedFile.name}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {formatBytes(selectedFile.size)}
                </p>
              </div>
              <div
                className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin shrink-0"
                style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {state === 'uploading' ? 'Reading file…' : 'Converting to AZW3…'}
                </p>
                <p className="text-xs font-medium" style={{ color: 'var(--accent-light)' }}>
                  {progress}%
                </p>
              </div>
              <div
                className="w-full h-1.5 rounded-full overflow-hidden"
                style={{ background: 'var(--surface-2)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${progress}%`, background: 'var(--accent)' }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Done state */}
        {state === 'done' && result && (
          <div
            className="rounded-2xl overflow-hidden"
            style={{ border: '1px solid var(--border)' }}
          >
            {/* Success banner */}
            <div
              className="px-6 py-3 flex items-center gap-2"
              style={{ background: 'rgba(34,197,94,0.08)', borderBottom: '1px solid rgba(34,197,94,0.2)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <p className="text-sm font-medium" style={{ color: 'var(--success)' }}>
                Conversion successful
              </p>
            </div>

            {/* File info */}
            <div className="px-6 py-5 flex items-center gap-4" style={{ background: 'var(--surface)' }}>
              <FileIcon type="azw3" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
                  {result.filename}
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {formatBytes(result.originalSize)}
                  </span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span className="text-xs" style={{ color: 'var(--success)' }}>
                    {formatBytes(result.convertedSize)}
                  </span>
                </div>
              </div>

              <button
                onClick={downloadResult}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 hover:opacity-90 active:scale-95 shrink-0"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download
              </button>
            </div>

            {/* Convert another */}
            <div
              className="px-6 py-3 flex items-center justify-between"
              style={{ background: 'var(--surface-2)', borderTop: '1px solid var(--border)' }}
            >
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Ready to convert another file?
              </p>
              <button
                onClick={resetState}
                className="text-xs font-medium transition-colors hover:opacity-80"
                style={{ color: 'var(--accent-light)' }}
              >
                Convert another →
              </button>
            </div>
          </div>
        )}

        {/* Feature cards */}
        {state === 'idle' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
            {[
              {
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                ),
                title: 'EPUB → AZW3',
                desc: 'Preserves original text formatting, styles, and chapter structure.',
              },
              {
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                ),
                title: 'PDF → AZW3',
                desc: 'Strips headers, footers, and page numbers. Chapters start on new pages.',
              },
              {
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                ),
                title: 'Private & Secure',
                desc: 'Files are processed in memory and never stored on our servers.',
              },
            ].map((card, i) => (
              <div
                key={i}
                className="rounded-xl p-4 flex flex-col gap-3"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center"
                  style={{ background: 'var(--surface-2)' }}
                >
                  {card.icon}
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                    {card.title}
                  </p>
                  <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {card.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer
        className="border-t py-5"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="max-w-3xl mx-auto px-6 flex items-center justify-between">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Ebook Converter
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            PDF & EPUB to AZW3 · Built for Kindle
          </p>
        </div>
      </footer>
    </div>
  );
}
