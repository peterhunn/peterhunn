import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "x490 Dashboard",
  description: "x490 Facilitator operator dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
