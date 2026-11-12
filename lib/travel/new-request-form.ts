/**
 * Client-safe validation for the new-request page. Pure and dependency-free so the
 * browser and the unit tests share it. The server schema (workflow.ts) stays the
 * authority; this only gives early, field-level feedback and mirrors its limits.
 */

export interface NewRequestTravelers {
  adults: number; children: number; infants: number; childAges: number[];
  paying: number; complimentary: number; leaders: number; staff: number;
}
export interface NewRequestForm {
  agencyId: string; agencyRef: string; title: string; startDate: string; endDate: string;
  templateVersionId: string; travelers: NewRequestTravelers;
  /** Visible to the agency (partner) on the quotation request. */
  clientNotes: string;
  /** Staff only. */
  notes: string;
}
export const EMPTY_NEW_REQUEST: NewRequestForm = {
  agencyId: "", agencyRef: "", title: "", startDate: "", endDate: "", templateVersionId: "",
  travelers: { adults: 2, children: 0, infants: 0, childAges: [], paying: 1, complimentary: 0, leaders: 0, staff: 0 },
  clientNotes: "", notes: "",
};

export type FieldErrors = Partial<Record<"agencyId" | "agencyRef" | "title" | "startDate" | "endDate" | "travelers" | "clientNotes" | "notes", string>>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 4000;

export function validateNewRequest(f: NewRequestForm): FieldErrors {
  const e: FieldErrors = {};
  if (!f.agencyId) e.agencyId = "Select the agency this request is for.";
  if (f.agencyRef.length > 200) e.agencyRef = "Keep the agency reference under 200 characters.";
  if (!f.title.trim()) e.title = "Enter a title for the request.";
  else if (f.title.length > 200) e.title = "Keep the title under 200 characters.";
  if (!f.startDate) e.startDate = "Pick the start date.";
  else if (!ISO.test(f.startDate)) e.startDate = "Use a valid start date.";
  if (!f.endDate) e.endDate = "Pick the end date.";
  else if (!ISO.test(f.endDate)) e.endDate = "Use a valid end date.";
  else if (ISO.test(f.startDate) && !(f.endDate > f.startDate)) e.endDate = "The end date must be after the start date.";

  const t = f.travelers;
  const nums = [t.adults, t.children, t.infants, t.paying, t.complimentary, t.leaders, t.staff];
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) e.travelers = "Traveller counts must be whole numbers, zero or more.";
  else if (t.childAges.length !== t.children) e.travelers = "Enter an age for every child.";
  else if (t.infants > t.children) e.travelers = "Infants cannot outnumber children.";

  if (f.clientNotes.length > MAX_TEXT) e.clientNotes = "Keep client messages under 4000 characters.";
  if (f.notes.length > MAX_TEXT) e.notes = "Keep internal notes under 4000 characters.";
  return e;
}

/** Per-user key: a draft restored in a shared browser tab can only ever be the same person's. */
export const draftKey = (userId: string) => `travel:new-request:draft:v2:${userId}`;
export const DRAFT_PREFIX = "travel:new-request:draft:";
/** Removes every new-request draft held by this tab (called on sign-out). Never throws. */
export function clearAllDrafts(): void {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(k);
  } catch { /* storage unavailable */ }
}

export const hasErrors = (e: FieldErrors) => Object.keys(e).length > 0;

/** DOM ids in page order, so focus lands on the first invalid field. */
const ORDER: Array<[keyof FieldErrors, string]> = [
  ["agencyId", "nr-agency"], ["agencyRef", "nr-agency-ref"], ["title", "nr-title"], ["startDate", "nr-start"],
  ["endDate", "nr-end"], ["travelers", "nr-travelers"], ["clientNotes", "nr-client-notes"], ["notes", "nr-internal-notes"],
];
export function firstErrorId(e: FieldErrors): string | null {
  for (const [k, id] of ORDER) if (e[k]) return id;
  return null;
}
