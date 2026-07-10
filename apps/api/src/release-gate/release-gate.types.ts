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

export type ReleaseGateSummary = {
  pass: number;
  warning: number;
  fail: number;
};

export type ReleaseGateResponse = {
  status: ReleaseGateStatus;
  generatedAt: string;
  checks: ReleaseGateCheck[];
  summary: ReleaseGateSummary;
};
