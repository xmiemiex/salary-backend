export type HealthStatus = 'ok' | 'warning' | 'critical';

export type SystemHealthCheck = {
  code: string;
  status: HealthStatus;
  title: string;
  message: string;
  safeDetails?: Record<string, unknown>;
  remediation?: string;
  updatedAt: string;
};

export type SystemHealthResponse = {
  status: HealthStatus;
  generatedAt: string;
  environment: Record<string, unknown>;
  database: Record<string, unknown>;
  syncPlanning: Record<string, unknown>;
  autoExecution: Record<string, unknown>;
  credentials: Record<string, unknown>;
  settlements: Record<string, unknown>;
  dataProtection: Record<string, unknown>;
  recentIncidents: Array<Record<string, unknown>>;
  audit: Record<string, unknown>;
  e2e: Record<string, unknown>;
  checks: SystemHealthCheck[];
};

const SENSITIVE_TERMS = [
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'apiKey',
  'secret',
  'clientSecret',
  'merchantId',
  'authorization',
  'bearer',
  'encryptedPayload',
  'credentialPayload',
  'DATABASE_URL',
  'cookie',
  'set-cookie',
  'providerResponse',
  'rawResponse',
  'requestHeaders',
  'responseHeaders',
  'leaseOwner',
  'file://',
  's3://',
  'gs://',
  'http://',
  'https://',
];

export function statusColor(status: HealthStatus): string {
  if (status === 'ok') return 'green';
  if (status === 'warning') return 'gold';
  return 'red';
}

export function statusLabel(status: HealthStatus): string {
  if (status === 'ok') return 'OK';
  if (status === 'warning') return 'Warning';
  return 'Critical';
}

export function sortChecks(checks: SystemHealthCheck[]): SystemHealthCheck[] {
  const rank: Record<HealthStatus, number> = { critical: 0, warning: 1, ok: 2 };
  return [...checks].sort((a, b) => {
    const leftRank = rank[a.status] ?? 99;
    const rightRank = rank[b.status] ?? 99;
    return leftRank - rightRank || String(a.code ?? '').localeCompare(String(b.code ?? ''));
  });
}

export function containsSensitiveSystemHealthField(value: unknown): boolean {
  const text = JSON.stringify(value);
  return SENSITIVE_TERMS.some((term) => new RegExp(escapeRegExp(term), 'i').test(text));
}

export function safeDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[UNDISPLAYABLE]';
  }
}

export function sectionRows(section: Record<string, unknown>): Array<{ key: string; value: string }> {
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return [{ key: 'value', value: safeDisplayValue(section) }];
  }
  return Object.entries(section).map(([key, value]) => ({ key, value: safeDisplayValue(value) }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
