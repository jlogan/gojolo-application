import type { SupabaseClient } from "@supabase/supabase-js";

export function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase();
}

type CompanyRow = { id: string; name: string };

export function findCompanyByNormalizedName<T extends CompanyRow>(
  companies: T[],
  name: string,
): T | undefined {
  const normalized = normalizeCompanyName(name);
  return companies.find(
    (company) => normalizeCompanyName(company.name) === normalized,
  );
}

type FindOrCreateCompanyParams = {
  orgId: string;
  name: string;
  industry?: string | null;
  sourcedFromLead?: boolean;
};

export async function findOrCreateCompany(
  client: SupabaseClient,
  params: FindOrCreateCompanyParams,
): Promise<{ id: string; name: string; created: boolean }> {
  const trimmedName = params.name.trim();
  if (!trimmedName) throw new Error("Company name is required");

  const { data: rows, error: findErr } = await client
    .from("companies")
    .select("id, name")
    .eq("org_id", params.orgId);

  if (findErr) throw findErr;

  const existing = findCompanyByNormalizedName(rows ?? [], trimmedName);
  if (existing) {
    return { id: existing.id, name: existing.name, created: false };
  }

  const payload: Record<string, unknown> = {
    org_id: params.orgId,
    name: trimmedName,
  };
  if (params.industry !== undefined) payload.industry = params.industry;
  if (params.sourcedFromLead) payload.sourced_from_lead = true;

  const { data: created, error: insertErr } = await client
    .from("companies")
    .insert(payload)
    .select("id")
    .single();

  if (insertErr) throw insertErr;
  return {
    id: (created as { id: string }).id,
    name: trimmedName,
    created: true,
  };
}
