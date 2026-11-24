import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WA Sales Concierge | المساعد الذكي لمبيعات المتاجر عبر واتساب",
  description:
    "Multi-store Zero-Hallucination AI WhatsApp Sales Concierge for Saudi & GCC Salla/Zid E-Commerce Stores.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
