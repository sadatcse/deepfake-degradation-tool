import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DeepFake Bulk Video Degradation Tool',
  description:
    'Local bulk video degradation for deepfake detection research. Runs entirely on this machine - no database, no cloud, no upload.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Applied before first paint so a dark-mode user never sees a white flash.
 * Kept inline and tiny; it is the only script that runs ahead of React.
 */
const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('ddt-theme');
    var dark = stored ? stored === 'dark' : true;
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
