import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PROJECT CEILING DRIFT | Aerodynamic Telemetry & Orbital Displacement Matrix',
  description: 'Project Ceiling Drift: Aerodynamic Telemetry & Orbital Fan Displacement System (AT-OFDS). In-browser optical pulse tachometer and pointless odometry tracking.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased min-h-screen bg-[#04070d] text-[#e2e8f0] font-mono">
        {children}
      </body>
    </html>
  );
}
