import type { Metadata } from "next";
import "./globals.css";

const SITE_TITLE = "مساعد المبيعات الذكي لمتاجر الذهب والمجوهرات";
const SITE_DESCRIPTION =
  "رد فوري باللهجة السعودية على استفسارات العيار والوزن والسعر وتابي وتمارا 24/7 مع رابط الطلب المباشر — مخصص لمتاجر سلة وزد.";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "ar_SA",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
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
