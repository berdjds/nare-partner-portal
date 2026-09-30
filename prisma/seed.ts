import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ensureDefaultAccounts } from "../lib/whatsapp-accounts";

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

  const hashed = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "Administrator",
      password: hashed,
      role: "ADMIN",
    },
  });

  console.log(`Seeded admin user: ${adminEmail}`);

  // W3: create the Marhaba (enabled) and Nare (disabled) WhatsApp account
  // rows. Idempotent and never modifies existing rows, so it runs on every
  // deploy through the bootstrap seed path (scripts/vps-deploy.sh).
  await ensureDefaultAccounts();
  console.log("Ensured default WhatsApp accounts (marhaba, nare)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    // ensureDefaultAccounts() runs on the lib/prisma singleton — disconnect
    // both clients so the seed process can exit.
    const { prisma: shared } = await import("../lib/prisma");
    await Promise.all([prisma.$disconnect(), shared.$disconnect()]);
  });
