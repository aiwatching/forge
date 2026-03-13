import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Forge',
  description: 'Unified AI workflow platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[var(--bg-primary)]">
        {children}
      </body>
    </html>
  );
}
