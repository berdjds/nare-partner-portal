import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../../../../lib/security/hash";
const prisma = new PrismaClient();
(async () => {
  const pw = await hashPassword("Browser-Check-Passw0rd!");
  const agency = await prisma.agency.create({ data: { shortCode: "DEMO", name: "Demo Travel" } });
  await prisma.agency.create({ data: { shortCode: "OTHR", name: "Other Agency" } });
  await prisma.user.create({ data: { email: "advisor@browser.test", name: "Ava Advisor", password: pw, role: "ADVISOR" } });
  await prisma.user.create({ data: { email: "partner@browser.test", name: "Pia Partner", password: pw, role: "PARTNER", agencyId: agency.id } });
  const tour = await prisma.serviceProduct.create({ data: { name: "City tour", category: "TICKETS", basis: "PER_PERSON" } });
  const leader = await prisma.serviceProduct.create({ data: { name: "Leader meal", category: "TOUR_LEADER", basis: "PER_PERSON" } });
  const group = await prisma.serviceProduct.create({ data: { name: "Group tour", category: "TICKETS", basis: "PER_PERSON" } });
  for (const p of [tour, leader, group]) await prisma.rateVersion.create({ data: { productType: "SERVICE", serviceProductId: p.id, amount: "10", currency: "USD", status: "VERIFIED", evidenceRef: "demo" } });
  const t = await prisma.packageTemplate.create({ data: { code: "DEMO-3N", name: "Demo three nights" } });
  await prisma.templateVersion.create({ data: { templateId: t.id, nights: 3, days: 4, daysJson: JSON.stringify([
    { dayOffset: 0, services: [{ serviceProductId: tour.id, label: "City tour", quantity: 1 }, { serviceProductId: leader.id, label: "Leader meal", quantity: 1, rule: { appliesTo: ["leader"] } }] },
    { dayOffset: 1, services: [{ serviceProductId: group.id, label: "Group tour", quantity: 1, rule: { weekdays: [3, 5, 7], minParticipants: 4 } }] } ]) } });
  await prisma.pricingPolicyVersion.create({ data: { name: "Std", type: "MARKUP_ON_COST", rate: "0.14", roundingIncrement: "1", quoteCurrency: "USD", active: true } });
  await prisma.fXRateVersion.create({ data: { currency: "USD", amdPerUnit: "365", effectiveFrom: "2026-01-01" } });
  console.log("seeded");
})().finally(() => prisma.$disconnect());
