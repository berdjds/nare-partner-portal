import AppShell from "@/components/app/AppShell";

/**
 * Travel module route layout: wraps every /travel page in the W4 shared
 * AppShell (fixed 240px sidebar on lg+, Sheet-based mobile nav below lg,
 * max-w-6xl content column). AppShell hides the chrome when there is no
 * active user — pages still guard themselves (redirect on no session / no
 * travel access); getActiveUser() re-reads the user row, so the chrome
 * reflects the current database role.
 */
export default function TravelLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
