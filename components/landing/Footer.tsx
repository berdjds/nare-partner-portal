import { PRODUCT_NAME } from "@/lib/portal-content";

export function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-2 px-6 py-10 text-center sm:flex-row sm:justify-between sm:text-left">
        <p className="text-sm font-medium text-foreground">{PRODUCT_NAME}</p>
        <p className="text-sm text-muted-foreground">Partner portal</p>
      </div>
    </footer>
  );
}
