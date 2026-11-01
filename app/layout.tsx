import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Chatbot & RAG Hallucination Checker",
  description: "Document Q&A chatbot with claim-level hallucination checking, batch audits, and Hugging Face dataset import.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
