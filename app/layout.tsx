import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import { WindowControls } from "@/components/window-controls";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// VJ Canopee — display face for the Yen wordmark
const canopee = localFont({
  src: "../public/fonts/Canopee.otf",
  variable: "--font-canopee",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Yen",
  description: "Personal AI command console.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${canopee.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Frameless-window drag handle — top 24px strip.
            In Tauri the data-tauri-drag-region attribute makes a region draggable.
            In a regular browser it's harmless. */}
        <div
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 z-50 h-6 pointer-events-auto"
          aria-hidden
        />
        <WindowControls />
        {children}
      </body>
    </html>
  );
}
