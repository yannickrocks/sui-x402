import type { ReactNode } from "react";

export const metadata = { title: "x402 paywall on Sui" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: "48rem", margin: "3rem auto", padding: "0 1rem" }}>
        {children}
      </body>
    </html>
  );
}
