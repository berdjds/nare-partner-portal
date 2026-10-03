"use client";

import { Calculator } from "lucide-react";

interface CalculatorFrameProps {
  html: string;
}

/**
 * W4: the calculator renders inside the shared AppShell, which owns
 * navigation, so the old header (Back button, dashboard link) is gone. What
 * remains is a slim title bar plus the sandboxed iframe, sized to fill the
 * viewport below the shell's 3.5rem mobile bar (same sizing as the chat
 * dashboard).
 */
export default function CalculatorFrame({ html }: CalculatorFrameProps) {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] h-[calc(100dvh-3.5rem)] flex-col bg-background lg:h-screen lg:h-dvh">
      <div className="flex items-center gap-2 border-b px-3 py-2 sm:px-4">
        <Calculator className="h-4 w-4 text-primary" />
        <h1 className="text-sm font-semibold">Package Calculator</h1>
        <p className="hidden text-xs text-muted-foreground sm:inline">
          Hello Armenia Package Calculator 2026
        </p>
      </div>
      <iframe
        title="Hello Armenia Package Calculator 2026"
        srcDoc={html}
        className="w-full flex-1 border-0"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </div>
  );
}
