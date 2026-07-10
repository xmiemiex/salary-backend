export type SystemHealthStatus = 'ok' | 'warning' | 'critical';

export type SystemHealthCheck = {
  code: string;
  status: SystemHealthStatus;
  title: string;
  message: string;
  safeDetails?: Record<string, unknown>;
  remediation?: string;
  updatedAt: string;
};

export type SystemHealthResponse = {
  status: SystemHealthStatus;
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
