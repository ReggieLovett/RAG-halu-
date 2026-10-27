import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Halu — AI workspace",
  description: "A focused AI chat workspace powered by Groq."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
