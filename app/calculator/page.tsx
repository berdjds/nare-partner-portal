import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { readFile } from "fs/promises";
import { join } from "path";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import AppShell from "@/components/app/AppShell";
import CalculatorFrame from "@/components/calculator/CalculatorFrame";

export default async function CalculatorPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");

  const filePath = join(
    process.cwd(),
    "doc",
    "temp",
    "Hello_Armenia_Package_Calculator_2026_v3.html"
  );
  const html = await readFile(filePath, "utf-8");

  // W4: the calculator renders inside the shared shell (variant "full" — the
  // iframe fills the whole content width). Navigation lives in the shell.
  return (
    <AppShell variant="full">
      <CalculatorFrame html={html} />
    </AppShell>
  );
}
