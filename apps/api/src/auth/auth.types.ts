export type Actor = {
  userId: string;
  roleCode: string;
  permissions: string[];
  employeeId?: string;
  ipAddress?: string;
  userAgent?: string;
};

export type RequestWithActor = {
  user?: Actor;
  actor?: Actor;
  authSessionId?: string;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
};

export type LoginInput = {
  username: string;
  password: string;
};

export type ChangePasswordInput = {
  currentPassword: unknown;
  newPassword: unknown;
  confirmPassword: unknown;
};
