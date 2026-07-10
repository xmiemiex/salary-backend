export const PASSWORD_RULE_MESSAGE = '密码必须为 12-256 个字符，且至少包含一个字母和一个数字。';

export function validatePasswordChange(values: { currentPassword?: string; newPassword?: string; confirmPassword?: string }): string | null {
  if (!values.currentPassword || !values.newPassword || !values.confirmPassword) return '请填写所有密码字段。';
  if (values.newPassword.length < 12 || values.newPassword.length > 256 || !/[A-Za-z]/.test(values.newPassword) || !/\d/.test(values.newPassword)) {
    return PASSWORD_RULE_MESSAGE;
  }
  if (values.newPassword !== values.confirmPassword) return '两次输入的新密码不一致。';
  if (values.currentPassword === values.newPassword) return '新密码不能与当前密码相同。';
  return null;
}

export function containsSensitiveSecurityField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSensitiveSecurityField);
  return Object.entries(value).some(([key, nested]) =>
    /^(password|passwordHash|token|tokenHash|authorization|cookie)$/i.test(key) || containsSensitiveSecurityField(nested),
  );
}

export async function runInvalidatingAction(request: () => Promise<unknown>, clearSession: () => void): Promise<void> {
  await request();
  clearSession();
}
