export type Actor = {
  userId: string;
  roleCode: string;
  ipAddress?: string;
  userAgent?: string;
};

export type ListQuery = {
  status?: string;
  settlementMonth?: string | Date;
  effectiveMonth?: string | Date;
  employeeId?: string;
  provider?: string;
};
