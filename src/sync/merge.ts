import { prisma } from "../db";

export type Row = Record<string, unknown>;

/** The few Prisma methods we use, so one function can serve every table. */
export interface Delegate {
  findUnique(args: any): Promise<any>;
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
}

export type MergeAction = "created" | "updated" | "linked" | "unchanged";

export interface MergeResult {
  id: number;
  action: MergeAction;
  changedFields: string[];
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if ((a && typeof a === "object") || (b && typeof b === "object")) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

function show(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function compact(data: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) if (!isEmpty(v)) out[k] = v;
  return out;
}

/**
 * THE MERGE RULES. For each field the provider sent:
 *  1. empty values are ignored (the provider never blanks existing data)
 *  2. locked fields are ignored (the admin pinned them)
 *  3. unchanged values are ignored
 *  4. everything else overwrites, and is reported as a change
 */
export function computePatch(existing: Row, incoming: Row, locked: string[]) {
  const patch: Row = {};
  const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  for (const [field, value] of Object.entries(incoming)) {
    if (isEmpty(value)) continue;
    if (locked.includes(field)) continue;
    if (same(existing[field], value)) continue;
    patch[field] = value;
    changes.push({ field, oldValue: show(existing[field]), newValue: show(value) });
  }
  return { patch, changes };
}

export async function mergeProviderRecord(opts: {
  entity: string; // "Player", "Team" ... (used in the audit log)
  delegate: Delegate;
  providerId: number;
  data: Row;
  /** Looks for an unlinked admin-created record that is clearly the same thing. */
  findAdminMatch?: (data: Row) => Promise<any | null>;
}): Promise<MergeResult> {
  const { entity, delegate, providerId, data } = opts;

  let existing = await delegate.findUnique({ where: { providerId } });
  let linking = false;

  if (!existing && opts.findAdminMatch) {
    existing = await opts.findAdminMatch(data);
    linking = existing !== null && existing !== undefined;
  }

  if (!existing) {
    const created = await delegate.create({
      data: { ...compact(data), providerId, createdBy: "PROVIDER" },
    });
    return { id: created.id, action: "created", changedFields: [] };
  }

  const { patch, changes } = computePatch(existing, data, existing.lockedFields ?? []);
  if (linking) {
    patch.providerId = providerId;
    changes.push({ field: "providerId", oldValue: null, newValue: String(providerId) });
  }
  if (changes.length === 0) {
    return { id: existing.id, action: "unchanged", changedFields: [] };
  }

  await delegate.update({ where: { id: existing.id }, data: patch });
  await prisma.changeLog.createMany({
    data: changes.map((c) => ({
      entity,
      entityId: existing.id,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      source: "provider",
    })),
  });
  return {
    id: existing.id,
    action: linking ? "linked" : "updated",
    changedFields: changes.map((c) => c.field),
  };
}