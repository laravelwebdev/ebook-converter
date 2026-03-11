import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ebook Converter — PDF & EPUB to AZW3',
  description: 'Convert PDF and EPUB ebooks to AZW3 (Kindle) format. Free, fast, and privacy-friendly — files are processed on the server and never stored.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  )
}
