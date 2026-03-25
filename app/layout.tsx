import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Forge',
  description: 'Unified AI workflow platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-[var(--bg-primary)]" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
