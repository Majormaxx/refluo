import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

// Named distinctly from Tailwind's own `--font-sans`/`--font-mono` theme
// tokens (globals.css maps the tokens to these by name) rather than
// reusing the token names directly: the previous Geist setup named its
// next/font variable identically to the Tailwind token it fed
// (`--font-sans: var(--font-sans)` in globals.css), a self-referential
// custom property. `--font-mono` had no mapping in `@theme inline` at
// all, so Geist Mono was loaded but never wired to the `font-mono`
// address/data cells that use it throughout the app.
const sans = Space_Grotesk({
  variable: "--font-sans-display",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono-data",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Refluo Operator Dashboard",
  description: "Vault overview, SLA telemetry, guardian pause, and timelock queue for a Refluo vault.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
