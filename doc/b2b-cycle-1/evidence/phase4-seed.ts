import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../../../lib/security/hash";
const prisma = new PrismaClient();
(async () => {
  const pw = await hashPassword("Browser-Check-Passw0rd!");
  const agency = await prisma.agency.create({ data: { shortCode: "DEMO", name: "Demo Travel" } });
  await prisma.user.create({ data: { email: "admin@browser.test", name: "Ada Admin", password: pw, role: "ADMIN" } });
  await prisma.user.create({ data: { email: "advisor@browser.test", name: "Ava Advisor", password: pw, role: "ADVISOR" } });
  await prisma.user.create({ data: { email: "partner@browser.test", name: "Pia Partner", password: pw, role: "PARTNER", agencyId: agency.id } });
  await prisma.serviceProduct.create({ data: { name: "Garni and Geghard tour", details: "Full day with lunch.", category: "TICKETS", basis: "PER_PERSON" } });
  await prisma.serviceProduct.create({ data: { name: "Wine tasting at Areni", category: "TICKETS", basis: "PER_PERSON" } });
  console.log("seeded");
})().finally(() => prisma.$disconnect());
