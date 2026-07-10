export type Actor = {
  userId: string;
  roleCode: string;
  permissions: string[];
  employeeId?: string;
  ipAddress?: string;
  userAgent?: string;
};

export type Session = {
  token: string;
  expiresAt?: string;
  actor: Actor;
};
