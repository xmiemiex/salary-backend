import { CommonStatus } from '@prisma/client';

export type EffectiveSubIdMapping = {
  id: string;
  affiliateAccountId: string;
  subField: string;
  subValue: string;
  effectiveMonth: Date;
  employeeId: string;
  status: CommonStatus;
  employee: {
    employeeCode: string;
    name: string;
    status: CommonStatus;
  };
};

export type EffectiveSubIdMappingReader = {
  subIdMapping: {
    findMany(args: unknown): Promise<EffectiveSubIdMapping[]>;
  };
};

export type ResolveEffectiveSubIdMappingsInput = {
  settlementMonth: Date;
  affiliateAccountId?: string;
  subField?: string;
  subValue?: string;
  subValues?: string[];
  employeeId?: string;
};

/**
 * Resolves versioned SUB mappings as of a settlement month.
 *
 * Status is deliberately not part of the database predicate. A disabled latest
 * version is authoritative and must prevent fallback to an older active row.
 */
export async function resolveEffectiveSubIdMappings(
  reader: EffectiveSubIdMappingReader,
  input: ResolveEffectiveSubIdMappingsInput,
): Promise<EffectiveSubIdMapping[]> {
  if (input.subValue !== undefined && input.subValues !== undefined) {
    throw new Error('subValue and subValues cannot be used together.');
  }
  const subValues = input.subValues ? [...new Set(input.subValues)] : undefined;
  if (subValues?.length === 0) return [];

  const rows = await reader.subIdMapping.findMany({
    where: {
      affiliateAccountId: input.affiliateAccountId,
      subField: input.subField,
      subValue: input.subValue ?? (subValues ? { in: subValues } : undefined),
      effectiveMonth: { lte: input.settlementMonth },
    },
    select: {
      id: true,
      affiliateAccountId: true,
      subField: true,
      subValue: true,
      effectiveMonth: true,
      employeeId: true,
      status: true,
      employee: { select: { employeeCode: true, name: true, status: true } },
    },
    orderBy: { effectiveMonth: 'desc' },
  });

  const latestByBusinessKey = new Map<string, { effectiveTime: number; rows: EffectiveSubIdMapping[] }>();
  for (const row of rows) {
    const key = mappingBusinessKey(row);
    const effectiveTime = row.effectiveMonth.getTime();
    const latest = latestByBusinessKey.get(key);
    if (!latest) {
      latestByBusinessKey.set(key, { effectiveTime, rows: [row] });
    } else if (effectiveTime > latest.effectiveTime) {
      latestByBusinessKey.set(key, { effectiveTime, rows: [row] });
    } else if (latest.effectiveTime === effectiveTime) {
      // The schema uniqueness constraint normally makes this impossible. Keep
      // same-month duplicates visible so callers can fail closed as a conflict.
      latest.rows.push(row);
    }
  }

  const effective = [...latestByBusinessKey.values()].flatMap((value) => value.rows);
  return input.employeeId
    ? effective.filter((mapping) => mapping.employeeId === input.employeeId)
    : effective;
}

export function isActiveEffectiveSubIdMapping(mapping: EffectiveSubIdMapping) {
  return mapping.status === CommonStatus.active;
}

export function isUsableEffectiveSubIdMapping(mapping: EffectiveSubIdMapping) {
  return isActiveEffectiveSubIdMapping(mapping) && mapping.employee.status === CommonStatus.active;
}

function mappingBusinessKey(mapping: Pick<EffectiveSubIdMapping, 'affiliateAccountId' | 'subField' | 'subValue'>) {
  return JSON.stringify([mapping.affiliateAccountId, mapping.subField, mapping.subValue]);
}
