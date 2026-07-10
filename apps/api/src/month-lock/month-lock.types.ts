export type LockActor = {
  userId: string;
  roleCode: string;
  ipAddress?: string;
  userAgent?: string;
};

export type MonthScopedWrite = {
  settlementMonth: Date;
  action: string;
  objectType: string;
  objectId?: string;
  requestPayload?: unknown;
};
