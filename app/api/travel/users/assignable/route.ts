import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTravelActor, travelError, unauthorized } from "../../guard";

// GET /api/travel/users/assignable — active users that can be assigned as
// validator. Open to any travel actor (unlike ADMIN-only /api/users): since
// v0.10.0 any active user is assignable, so owners need the full list.
export async function GET() {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const users = await prisma.user.findMany({
      where: { active: true, role: { not: "PARTNER" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true, phone: true },
    });
    return NextResponse.json(users);
  } catch (err) {
    return travelError(err, "[API /travel/users/assignable]");
  }
}
