export type BackupStatus = 'running' | 'succeeded' | 'failed' | 'expired' | 'unknown';
export type BackupType = 'full' | 'partial' | 'schema_only' | 'audit_only';
export type RestoreDrillStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ProtectionStatus = 'ok' | 'warning' | 'critical';

export type BackupRecord = {
  id: string;
  backupKey: string;
  status: BackupStatus;
  backupType: BackupType;
  startedAt: string;
  completedAt?: string | null;
  storageAlias: string;
  fileSizeBytes?: string | null;
  checksumSha256?: string | null;
  encrypted: boolean;
  encryptionAlias?: string | null;
  scopeSummary?: unknown;
  safeMetadata?: unknown;
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RestoreDrillRecord = {
  id: string;
  drillKey: string;
  status: RestoreDrillStatus;
  environmentAlias: string;
  backupKey?: string | null;
  startedAt: string;
  completedAt?: string | null;
  validationSummary?: unknown;
  safeMetadata?: unknown;
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BackupHealth = {
  latestBackup: Partial<BackupRecord> | null;
  latestSuccessfulBackup: Partial<BackupRecord> | null;
  latestRestoreDrill: Partial<RestoreDrillRecord> | null;
  latestSuccessfulRestoreDrill: Partial<RestoreDrillRecord> | null;
  daysSinceLastSuccessBackup: number | null;
  daysSinceLastSuccessDrill: number | null;
  status: ProtectionStatus;
  checks: Array<{ code: string; status: ProtectionStatus; message: string; safeDetails?: Record<string, unknown> }>;
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
  'providerResponse',
  'rawResponse',
  'file://',
  's3://',
  'gs://',
  'http://',
  'https://',
];

const UNSAFE_TEXT = /(?:file|s3|gs|https?):\/\/|[A-Za-z]:\\|\/var\/backups\/|\b(?:password|token|apiKey|apikey|secret|bearer|authorization|DATABASE_URL|credentialPayload|encryptedPayload)\b/i;

export function containsSensitiveBackupField(value: unknown): boolean {
  const text = JSON.stringify(value);
  return SENSITIVE_TERMS.some((term) => new RegExp(escapeRegExp(term), 'i').test(text)) || /[A-Za-z]:\\|\/var\/backups\//.test(text);
}

export function validateSafeInput(value: unknown): string | null {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (UNSAFE_TEXT.test(text)) return '输入包含 URL、绝对路径或敏感字段。';
  return null;
}

export function parseOptionalJson(value: string): unknown {
  if (!value.trim() || value.trim() === '-') return undefined;
  return JSON.parse(value);
}

export function compactJson(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[UNDISPLAYABLE]';
  }
}

export function statusColor(status: ProtectionStatus | BackupStatus | RestoreDrillStatus): string {
  if (status === 'ok' || status === 'succeeded') return 'green';
  if (status === 'warning' || status === 'running' || status === 'unknown' || status === 'cancelled') return 'gold';
  return 'red';
}

export function formatTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
