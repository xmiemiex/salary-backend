const SENSITIVE_WORDS = [
  'password',
  'token',
  'apiKey',
  'secret',
  'bearer',
  'authorization',
  'encryptedPayload',
  'DATABASE_URL',
  'leaseOwner',
  'providerResponse',
  'rawResponse',
  'requestHeaders',
  'responseHeaders',
];

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'active' | 'resolved' | 'silenced';

export type AlertItem = {
  id: string;
  fingerprint: string;
  severity: AlertSeverity;
  status: AlertStatus;
  source: string;
  category: string;
  title: string;
  safeMessage: string;
  safeDetails: unknown;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  silencedUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationItem = {
  id: string;
  alertId: string | null;
  type: string;
  severity: AlertSeverity;
  title: string;
  safeMessage: string;
  safeDetails: unknown;
  readAt: string | null;
  createdAt: string;
};

export function containsSensitiveAlertField(value: unknown): boolean {
  const text = JSON.stringify(value ?? '');
  return SENSITIVE_WORDS.some((word) => text.toLowerCase().includes(word.toLowerCase()));
}

export function severityColor(severity: AlertSeverity) {
  if (severity === 'critical') return 'red';
  if (severity === 'warning') return 'gold';
  return 'blue';
}

export function statusColor(status: AlertStatus) {
  if (status === 'active') return 'red';
  if (status === 'silenced') return 'purple';
  return 'green';
}

export function compactJson(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
