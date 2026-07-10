export type ReleaseGateStatus = 'pass' | 'warning' | 'fail';
export type ReleaseGateSeverity = 'required' | 'recommended';

export type ReleaseGateCheck = {
  code: string;
  severity: ReleaseGateSeverity;
  status: ReleaseGateStatus;
  title: string;
  message: string;
  safeDetails?: Record<string, unknown>;
  remediation: string;
};

export type ReleaseGateResponse = {
  status: ReleaseGateStatus;
  generatedAt: string;
  checks: ReleaseGateCheck[];
  summary: { pass: number; warning: number; fail: number };
};

const SENSITIVE_TERMS = [
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'apiKey',
  'secret',
  'bearer',
  'authorization',
  'DATABASE_URL',
  'encryptedPayload',
  'credentialPayload',
  'leaseOwner',
  'providerResponse',
  'rawResponse',
  'requestHeaders',
  'responseHeaders',
  'file://',
  's3://',
];

export function releaseGateStatusColor(status: ReleaseGateStatus): string {
  if (status === 'pass') return 'green';
  if (status === 'warning') return 'gold';
  return 'red';
}

export function releaseGateStatusLabel(status: ReleaseGateStatus): string {
  if (status === 'pass') return 'PASS';
  if (status === 'warning') return 'WARNING';
  return 'FAIL';
}

export function groupReleaseGateChecks(checks: ReleaseGateCheck[], severity: ReleaseGateSeverity): ReleaseGateCheck[] {
  const rank: Record<ReleaseGateStatus, number> = { fail: 0, warning: 1, pass: 2 };
  return checks
    .filter((item) => item.severity === severity)
    .sort((a, b) => rank[a.status] - rank[b.status] || a.code.localeCompare(b.code));
}

export function containsSensitiveReleaseGateField(value: unknown): boolean {
  const text = JSON.stringify(value);
  return SENSITIVE_TERMS.some((term) => new RegExp(escapeRegExp(term), 'i').test(text))
    || /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(text);
}

export function safeReleaseGateDetails(value: unknown): string {
  if (value === null || value === undefined) return '-';
  try {
    return JSON.stringify(value);
  } catch {
    return '[UNDISPLAYABLE]';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
