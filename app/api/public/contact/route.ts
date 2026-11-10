import { NextResponse } from "next/server";
import { getPublicContact } from "@/lib/contact/service";

// Public, unauthenticated: only fields the admin marked visible, never any key or draft.
export async function GET() {
  const c = await getPublicContact("portal");
  return NextResponse.json(c, { headers: { "Cache-Control": "public, max-age=60" } });
}
