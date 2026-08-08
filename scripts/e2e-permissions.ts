import { chromium, type Browser } from '@playwright/test';
import {
  AuditResult,
  AlertStatus,
  BackupStatus,
  BackupType,
  CommonStatus,
  PrismaClient,
  Provider,
  RestoreDrillStatus,
  SettlementStatus,
  SyncExecutionErrorCategory,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskTriggerType,
  SyncTaskType,
} from '@prisma/client';
import { PERMISSIONS, type PermissionCode } from '@salary/shared';
import { PasswordHashService } from '../apps/api/src/auth/password-hash.service';

const prisma = new PrismaClient();
const apiUrl = (process.env.E2E_API_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const webUrl = (process.env.E2E_WEB_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
const runPrefix = `e2e_perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const password = 'E2ePermission12345';
const forbiddenTerms = [
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'apiKey',
  'secret',
  'clientSecret',
  'merchantId',
  'encryptedPayload',
  'credentialPayload',
  'DATABASE_URL',
  'cookie',
  'set-cookie',
  'providerResponse',
  'rawResponse',
  'requestHeaders',
  'responseHeaders',
  'Authorization',
  'Bearer',
  'leaseOwner',
];

type LoginResult = {
  token: string;
  actor: { userId: string; roleCode: string; permissions: string[] };
};

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function main() {
  const startedAt = new Date();
  let fixture: Fixture | null = null;
  const checks: string[] = [];
  try {
    fixture = await seedFixture();
    checks.push('seed: isolated users, roles, sessions, tasks, affiliate account, locked month');

    await assert401Behavior();
    checks.push('401: missing and forged bearer tokens return 401');

    const incomeOnly = await assertBrowserSameSession403({
      token: '',
      actor: {
        userId: fixture.users.incomeOnly.id,
        roleCode: fixture.roles.incomeOnly.code,
        permissions: ['api_config.manage', 'income.import', 'salary.view_all'],
      },
    }, fixture.tasks.cardFailed.id, fixture.unlockedMonth);
    checks.push('task59 exception: same browser session request-retry returns 403 and keeps /me=200');

    const high = await login(fixture.users.high.username);
    const adminRead = await login(fixture.users.adminRead.username);
    const roleRead = await login(fixture.users.roleRead.username);
    const auditRead = await login(fixture.users.auditRead.username);
    const auditExport = await login(fixture.users.auditExport.username);
    const backupRead = await login(fixture.users.backupRead.username);
    const backupManage = await login(fixture.users.backupManage.username);
    const releaseRead = await login(fixture.users.releaseRead.username);
    const releaseRun = await login(fixture.users.releaseRun.username);
    const cakeSuper = await login(fixture.users.cakeSuper.username);
    const low = await login(fixture.users.low.username);
    checks.push('auth: test users logged in through real API/browser without tripping rate limits');

    await assertAdminUserPermissions(adminRead, low);
    checks.push('task53: admin-users read/manage boundaries');

    await assertRolePermissions(roleRead, low);
    checks.push('task54: role read/manage boundaries');

    await assertSecurityCenter(incomeOnly, fixture.otherSessionId);
    checks.push('task55: own security center and cross-user session revoke denial');

    await assertDashboardBoundaries(low, incomeOnly);
    checks.push('task56: dashboard does not expose unauthorized sync/finance sections');

    await assertSyncPlanning(incomeOnly, fixture.unlockedMonth);
    checks.push('task57: preview allowed, generate denied, preview is read-only');

    await assertSyncExecution(incomeOnly, fixture.tasks.cardFailed.id, fixture.tasks.manualPending.id);
    checks.push('task58: manual tasks are not auto-claimed, card execute denied');

    await assertOperations(high, incomeOnly, fixture.tasks.cardFailed.id, fixture.tasks.lockedFailed.id);
    checks.push('task59: operations retry/cancel denied and locked retry rejected');

    await assertCakeAdjustmentPermissions(cakeSuper, incomeOnly, low, fixture);
    checks.push('task96: CAKE adjustment requires super_admin plus income.import in page and direct API');

    await assertAuditCenter(high, auditRead, auditExport, low, fixture.auditLogIds.injection);
    checks.push('task61: audit center read/export permissions, CSV safety, and 403 session retention');

    await assertSystemHealthCenter(high, low);
    checks.push('task62: system health page/API permission, refresh, session retention, and sensitive scan');

    await assertBackupRecoveryCenter(high, backupRead, backupManage, low, fixture);
    checks.push('task64: backup recovery page/API permissions, create records, health summary, alert scan, and sensitive scan');

    await assertReleaseGateCenter(high, releaseRead, releaseRun, low);
    checks.push('task65: release gate page/API permissions, run action, required/recommended checks, session retention, and sensitive scan');

    await assertAlertsCenter(high, low, fixture);
    checks.push('task63: alerts center scan, notifications, read/ack/silence permissions, session retention, and sensitive scan');

    await assertSensitiveRuntimeSurfaces(startedAt, fixture.userIds, high);
    checks.push('sensitive scan: page text, key API JSON, and audit logs contain no forbidden sensitive terms');

    console.log(`E2E permissions passed (${checks.length} checks).`);
    for (const check of checks) console.log(`- ${check}`);
  } finally {
    const cleanup = await cleanupFixture(fixture, startedAt);
    console.log(`cleanup: ${cleanup}`);
    await prisma.$disconnect();
  }
}

async function seedFixture() {
  await ensurePermissionCatalog();
  const passwordHash = await new PasswordHashService().hash(password);
  const unlockedMonth = await nextUnusedMonth(new Date(Date.UTC(2090, 0, 1)));
  const lockedMonth = await nextUnusedMonth(new Date(Date.UTC(unlockedMonth.getUTCFullYear(), unlockedMonth.getUTCMonth() + 1, 1)));
  const employee = await prisma.employee.create({
    data: {
      employeeCode: `${runPrefix}_emp`,
      name: `${runPrefix} employee`,
      email: `${runPrefix}@example.test`,
      status: CommonStatus.active,
    },
  });
  const affiliateAccount = await prisma.affiliateAccount.create({
    data: {
      platform: 'everflow',
      accountCode: `${runPrefix}_acct`,
      accountName: `${runPrefix} account`,
      defaultEmployeeId: employee.id,
      status: CommonStatus.active,
    },
  });
  const affiliateCredential = await prisma.affiliateAccountCredential.create({
    data: {
      affiliateAccountId: affiliateAccount.id,
      encryptedPayload: `local-controlled-${runPrefix}`,
      maskedPayload: { configured: true, localOnly: true },
      status: CommonStatus.active,
    },
  });

  const roles = {
    high: await createRole('high', [...PERMISSIONS]),
    adminRead: await createRole('admin_read', ['admin_users.read']),
    roleRead: await createRole('role_read', ['role.read']),
    low: await createRole('low', ['salary.view_self']),
    incomeOnly: await createRole('income_only', ['api_config.manage', 'income.import', 'salary.view_all']),
    auditRead: await createRole('audit_read', ['audit_log.view']),
    auditExport: await createRole('audit_export', ['audit_log.view', 'audit_log.export']),
    backupRead: await createRole('backup_read', ['backup_status.read', 'restore_drill.read']),
    backupManage: await createRole('backup_manage', ['backup_status.read', 'backup_status.manage', 'restore_drill.read', 'restore_drill.manage', 'alerts.manage', 'alerts.read']),
    releaseRead: await createRole('release_read', ['release_gate.read']),
    releaseRun: await createRole('release_run', ['release_gate.read', 'release_gate.run']),
  };
  const superAdminRole = await prisma.role.findUnique({
    where: { code: 'super_admin' },
    include: { permissions: { include: { permission: true } } },
  });
  assert(superAdminRole?.status === CommonStatus.active, 'active super_admin role is required for permissions E2E');
  assert(
    superAdminRole.permissions.some((row) => row.permission.code === 'income.import'),
    'super_admin must include income.import for CAKE adjustment E2E',
  );
  const users = {
    high: await createUser('high', roles.high.id, passwordHash, employee.id),
    adminRead: await createUser('admin_read', roles.adminRead.id, passwordHash, employee.id),
    roleRead: await createUser('role_read', roles.roleRead.id, passwordHash, employee.id),
    low: await createUser('low', roles.low.id, passwordHash, employee.id),
    incomeOnly: await createUser('income_only', roles.incomeOnly.id, passwordHash, employee.id),
    auditRead: await createUser('audit_read', roles.auditRead.id, passwordHash, employee.id),
    auditExport: await createUser('audit_export', roles.auditExport.id, passwordHash, employee.id),
    backupRead: await createUser('backup_read', roles.backupRead.id, passwordHash, employee.id),
    backupManage: await createUser('backup_manage', roles.backupManage.id, passwordHash, employee.id),
    releaseRead: await createUser('release_read', roles.releaseRead.id, passwordHash, employee.id),
    releaseRun: await createUser('release_run', roles.releaseRun.id, passwordHash, employee.id),
    cakeSuper: await createUser('cake_super', superAdminRole.id, passwordHash, employee.id),
  };
  const cakeAccount = await prisma.affiliateAccount.create({
    data: {
      platform: 'cake',
      accountCode: `${runPrefix}_cake_329`,
      accountName: `${runPrefix} cake account`,
      status: CommonStatus.active,
    },
  });
  const cakeMapping = await prisma.subIdMapping.create({
    data: {
      affiliateAccountId: cakeAccount.id,
      subField: 'sub1',
      subValue: 'E2E',
      effectiveMonth: unlockedMonth,
      employeeId: employee.id,
      status: CommonStatus.active,
      createdBy: users.cakeSuper.id,
    },
  });
  const cakeBaseIncome = await prisma.incomeRecord.create({
    data: {
      settlementMonth: unlockedMonth,
      affiliateAccountId: cakeAccount.id,
      employeeId: employee.id,
      source: 'cake',
      externalRecordId: `${runPrefix}_cake_base`,
      subField: 'sub1',
      subValue: 'E2E',
      incomeUsd: '10',
      rawData: { providerTimezone: 'cake_system_default', localOnly: true },
      status: CommonStatus.confirmed,
      importedBy: users.cakeSuper.id,
    },
  });
  const otherSession = await prisma.adminSession.create({
    data: {
      adminUserId: users.high.id,
      tokenHash: Buffer.from(runPrefix).toString('hex').padEnd(64, '0').slice(0, 64),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  await prisma.monthlySettlement.create({
    data: {
      settlementMonth: lockedMonth,
      status: SettlementStatus.locked,
      lockedAt: new Date(),
      lockedBy: users.high.id,
      lockReason: `${runPrefix} locked test month`,
    },
  });

  const tasks = {
    pending: await createTask(unlockedMonth, SyncTaskStatus.pending, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id }),
    failed: await createTask(unlockedMonth, SyncTaskStatus.failed, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id, lastErrorCategory: SyncExecutionErrorCategory.NETWORK_ERROR }),
    retryWait: await createTask(unlockedMonth, SyncTaskStatus.retry_wait, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id, lastErrorCategory: SyncExecutionErrorCategory.TIMEOUT }),
    running: await createTask(unlockedMonth, SyncTaskStatus.running, SyncTaskSourceType.affiliate_income, {
      affiliateAccountId: affiliateAccount.id,
      leaseOwner: `${runPrefix}-worker`,
      leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }),
    completed: await createTask(unlockedMonth, SyncTaskStatus.completed, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id }),
    cancelled: await createTask(unlockedMonth, SyncTaskStatus.cancelled, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id }),
    manualPending: await createTask(unlockedMonth, SyncTaskStatus.pending, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id, triggerType: SyncTaskTriggerType.manual }),
    scheduled: await createTask(unlockedMonth, SyncTaskStatus.pending, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id, triggerType: SyncTaskTriggerType.scheduled, planningKey: `${runPrefix}:scheduled` }),
    cardFailed: await createTask(unlockedMonth, SyncTaskStatus.failed, SyncTaskSourceType.card_spend, { provider: Provider.airwallex, lastErrorCategory: SyncExecutionErrorCategory.NETWORK_ERROR }),
    affiliateFailed: await createTask(unlockedMonth, SyncTaskStatus.failed, SyncTaskSourceType.affiliate_income, { affiliateAccountId: affiliateAccount.id, lastErrorCategory: SyncExecutionErrorCategory.NETWORK_ERROR }),
    lockedFailed: await createTask(lockedMonth, SyncTaskStatus.failed, SyncTaskSourceType.card_spend, { provider: Provider.airwallex, lastErrorCategory: SyncExecutionErrorCategory.MONTH_LOCKED }),
    missingCredential: await createTask(unlockedMonth, SyncTaskStatus.failed, SyncTaskSourceType.card_spend, { provider: Provider.photonpay, lastErrorCategory: SyncExecutionErrorCategory.CREDENTIAL_MISSING }),
  };

  const injectionAudit = await prisma.auditLog.create({
    data: {
      actorUserId: users.high.id,
      actorRole: roles.high.code,
      action: 'auth.test_formula',
      objectType: 'admin_user',
      objectId: '=cmd',
      result: AuditResult.success,
      requestPayload: {
        requestId: `${runPrefix}_request`,
        localOnly: true,
        nested: [{ safe: 'value' }],
        text: 'safe formula export row',
      },
      afterData: { safe: 'value' },
      ipAddress: '127.0.0.1',
      userAgent: `${runPrefix} e2e agent`,
      createdAt: new Date(),
    },
  });

  return {
    unlockedMonth,
    lockedMonth,
    employeeId: employee.id,
    affiliateAccountId: affiliateAccount.id,
    affiliateCredentialId: affiliateCredential.id,
    cakeAccountId: cakeAccount.id,
    cakeMappingId: cakeMapping.id,
    cakeBaseIncomeId: cakeBaseIncome.id,
    cakeAdjustmentIds: [] as string[],
    otherSessionId: otherSession.id,
    roleIds: Object.values(roles).map((role) => role.id),
    userIds: Object.values(users).map((user) => user.id),
    roles,
    users,
    tasks,
    auditLogIds: { injection: injectionAudit.id },
    backupRecordIds: [] as string[],
    restoreDrillIds: [] as string[],
    createdAlertIds: [] as string[],
  };
}

async function assertCakeAdjustmentPermissions(
  cakeSuper: LoginResult,
  incomeOnly: LoginResult,
  low: LoginResult,
  fixture: Fixture,
) {
  const monthText = fixture.unlockedMonth.toISOString().slice(0, 7);
  const query = `/cake-income-adjustments?affiliateAccountId=${encodeURIComponent(fixture.cakeAccountId)}&settlementMonth=${monthText}`;
  assert((await rawApi(query)).status === 401, 'unauthenticated CAKE adjustment list must return 401');
  await expectStatus(incomeOnly.token, query, 403);
  await expectStatus(low.token, query, 403);
  await expectMeAlive(incomeOnly.token, incomeOnly.actor.userId);
  await expectMeAlive(low.token, low.actor.userId);

  const initial = objectPayload(await expectStatus(cakeSuper.token, query, 200));
  assert(initial.summary?.baseRevenueUsd === '10', 'super_admin CAKE adjustment base Revenue mismatch');
  assert(initial.summary?.confirmedAdjustmentCount === 0, 'CAKE adjustment E2E must start without adjustments');

  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(`${webUrl}/login`);
    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: cakeSuper.token, actor: cakeSuper.actor });
    await page.goto(`${webUrl}/cake-income-adjustments`);
    await page.getByRole('heading', { name: 'CAKE SUB 月度收入调整' }).waitFor({ timeout: 20_000 });
    await page
      .locator('.ant-select-selection-item')
      .filter({ hasText: `${runPrefix} cake account / ${runPrefix}_cake_329` })
      .waitFor({ timeout: 20_000 });
    await page.locator('input[type="month"]').fill(monthText);
    await page.getByText('E2E', { exact: true }).waitFor({ timeout: 20_000 });
    assertNoSensitiveTerms('CAKE adjustment page text', await page.locator('body').innerText());
  } finally {
    await context.close();
    await browser.close();
  }

  const body = {
    affiliateAccountId: fixture.cakeAccountId,
    settlementMonth: monthText,
    subValue: 'E2E',
    actualRevenueUsd: '11',
    reason: `${runPrefix} CAKE adjustment permission E2E`,
  };
  await expectStatus(incomeOnly.token, '/cake-income-adjustments', 403, { method: 'POST', body });
  await expectStatus(low.token, '/cake-income-adjustments', 403, { method: 'POST', body });
  const draft = objectPayload(await expectStatus(cakeSuper.token, '/cake-income-adjustments', 201, { method: 'POST', body }));
  assert(draft.status === CommonStatus.draft && draft.incomeUsd === '1', 'super_admin could not create CAKE adjustment draft');
  fixture.cakeAdjustmentIds.push(draft.id);
  const confirmed = objectPayload(await expectStatus(cakeSuper.token, `/cake-income-adjustments/${draft.id}/confirm`, 200, { method: 'PATCH' }));
  assert(confirmed.status === CommonStatus.confirmed, 'super_admin could not confirm CAKE adjustment');
  const disabled = objectPayload(await expectStatus(cakeSuper.token, `/cake-income-adjustments/${draft.id}/disable`, 200, { method: 'PATCH' }));
  assert(disabled.status === CommonStatus.disabled, 'super_admin could not disable CAKE adjustment');
  const auditCount = await prisma.auditLog.count({
    where: { objectId: draft.id, action: { in: ['cake_income_adjustment.save_draft', 'cake_income_adjustment.confirm', 'cake_income_adjustment.disable'] } },
  });
  assert(auditCount === 3, `CAKE adjustment E2E expected 3 audits, got ${auditCount}`);
}

async function ensurePermissionCatalog() {
  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, name: code, description: `Permission ${code}` },
    });
  }
}

async function createRole(suffix: string, permissions: PermissionCode[]) {
  const role = await prisma.role.create({
    data: {
      code: `${runPrefix}_${suffix}`,
      name: `${runPrefix} ${suffix}`,
      status: CommonStatus.active,
    },
  });
  const permissionRows = await prisma.permission.findMany({ where: { code: { in: permissions } }, select: { id: true } });
  await prisma.rolePermission.createMany({
    data: permissionRows.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
  });
  return role;
}

async function createUser(suffix: string, roleId: string, passwordHash: string, employeeId: string) {
  const user = await prisma.adminUser.create({
    data: {
      username: `${runPrefix}_${suffix}`,
      passwordHash,
      displayName: `${runPrefix} ${suffix}`,
      email: `${runPrefix}_${suffix}@example.test`,
      employeeId,
      status: CommonStatus.active,
    },
  });
  await prisma.adminUserRole.create({ data: { adminUserId: user.id, roleId } });
  return user;
}

async function createTask(
  settlementMonth: Date,
  status: SyncTaskStatus,
  sourceType: SyncTaskSourceType,
  options: {
    affiliateAccountId?: string;
    provider?: Provider;
    triggerType?: SyncTaskTriggerType;
    planningKey?: string;
    leaseOwner?: string;
    leaseExpiresAt?: Date;
    lastErrorCategory?: SyncExecutionErrorCategory;
  },
) {
  const isAffiliate = sourceType === SyncTaskSourceType.affiliate_income;
  return prisma.syncTask.create({
    data: {
      sourceType,
      taskType: isAffiliate ? SyncTaskType.affiliate_income : options.provider === Provider.photonpay ? SyncTaskType.photonpay_card : SyncTaskType.airwallex_card,
      platform: isAffiliate ? SyncTaskPlatform.everflow : options.provider === Provider.photonpay ? SyncTaskPlatform.photonpay : SyncTaskPlatform.airwallex,
      affiliateAccountId: options.affiliateAccountId,
      provider: options.provider,
      settlementMonth,
      status,
      triggerType: options.triggerType ?? SyncTaskTriggerType.manual,
      planningKey: options.planningKey,
      leaseOwner: options.leaseOwner,
      leaseExpiresAt: options.leaseExpiresAt,
      lastErrorCategory: options.lastErrorCategory,
      errorMessage: options.lastErrorCategory ? 'Safe redacted test error.' : null,
      message: `${runPrefix} safe test task`,
      requestPayload: { localOnly: true, runPrefix },
      resultPayload: { localOnly: true, pulledThirdPartyData: false },
    },
  });
}

async function assert401Behavior() {
  const noToken = await rawApi('/me');
  assert(noToken.status === 401, `expected /me without token to return 401, got ${noToken.status}`);
  const forged = await rawApi('/me', { token: 'forged.invalid.value' });
  assert(forged.status === 401, `expected /me with forged token to return 401, got ${forged.status}`);

  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(`${webUrl}/dashboard`);
    await page.evaluate(() => {
      window.sessionStorage.setItem('salary_admin_session_token', 'forged.invalid.value');
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify({ userId: 'fake', roleCode: 'fake', permissions: [] }));
    });
    await page.reload();
    await page.waitForURL('**/login', { timeout: 15_000 });
    await page.waitForFunction(() => window.sessionStorage.getItem('salary_admin_session_token') === null, undefined, { timeout: 15_000 });
    const tokenAfter401 = await page.evaluate(() => window.sessionStorage.getItem('salary_admin_session_token'));
    assert(tokenAfter401 === null, 'frontend did not clear local session after 401');
  } finally {
    await context.close();
    await browser.close();
  }
}

async function assertAdminUserPermissions(adminRead: LoginResult, low: LoginResult) {
  await expectStatus(adminRead.token, '/admin-users', 200);
  await expectStatus(adminRead.token, '/admin-users', 403, {
    method: 'POST',
    body: { username: `${runPrefix}_blocked`, email: `${runPrefix}_blocked@example.test`, password, roleIds: [] },
  });
  await expectMeAlive(adminRead.token, adminRead.actor.userId);
  await expectStatus(low.token, '/admin-users', 403);
  await expectMeAlive(low.token, low.actor.userId);
}

async function assertRolePermissions(roleRead: LoginResult, low: LoginResult) {
  await expectStatus(roleRead.token, '/roles', 200);
  await expectStatus(roleRead.token, '/roles', 403, {
    method: 'POST',
    body: { name: `${runPrefix} blocked`, permissionIds: [] },
  });
  await expectStatus(low.token, '/roles', 403);
  await expectMeAlive(roleRead.token, roleRead.actor.userId);
  await expectMeAlive(low.token, low.actor.userId);
}

async function assertSecurityCenter(actor: LoginResult, otherSessionId: string) {
  await expectStatus(actor.token, '/auth/security', 200);
  await expectStatus(actor.token, '/auth/sessions', 200);
  await expectStatus(actor.token, `/auth/sessions/${otherSessionId}/revoke`, 403, { method: 'POST' });
  await expectMeAlive(actor.token, actor.actor.userId);
}

async function assertDashboardBoundaries(low: LoginResult, incomeOnly: LoginResult) {
  const lowDashboard = await expectStatus(low.token, '/dashboard/overview', 200);
  assert(!('sync' in objectPayload(lowDashboard)), 'low dashboard unexpectedly includes sync section');
  await expectStatus(low.token, '/sync-tasks', 403);
  await expectMeAlive(low.token, low.actor.userId);

  const incomeDashboard = await expectStatus(incomeOnly.token, '/dashboard/overview', 200);
  assert('sync' in objectPayload(incomeDashboard), 'income-only dashboard should include sync section');
  assert(!('settlement' in objectPayload(incomeDashboard)), 'income-only dashboard should not include settlement section');
}

async function assertSyncPlanning(incomeOnly: LoginResult, month: Date) {
  const monthText = month.toISOString().slice(0, 7);
  const beforeTasks = await prisma.syncTask.count({ where: { settlementMonth: month } });
  const beforeAudits = await prisma.auditLog.count({ where: { actorUserId: incomeOnly.actor.userId } });
  await expectStatus(incomeOnly.token, `/sync-planning/preview?settlementMonth=${monthText}`, 200);
  const afterTasks = await prisma.syncTask.count({ where: { settlementMonth: month } });
  const afterAudits = await prisma.auditLog.count({ where: { actorUserId: incomeOnly.actor.userId } });
  assert(afterTasks === beforeTasks, 'sync planning preview wrote sync tasks');
  assert(afterAudits === beforeAudits, 'sync planning preview wrote audit logs');
  await expectStatus(incomeOnly.token, '/sync-planning/generate', 403, { method: 'POST', body: { settlementMonth: monthText } });
  await expectMeAlive(incomeOnly.token, incomeOnly.actor.userId);
}

async function assertSyncExecution(incomeOnly: LoginResult, cardTaskId: string, manualTaskId: string) {
  await expectStatus(incomeOnly.token, `/sync-tasks/${cardTaskId}/execute`, 403, { method: 'POST' });
  await expectMeAlive(incomeOnly.token, incomeOnly.actor.userId);
  const manual = await prisma.syncTask.findUniqueOrThrow({ where: { id: manualTaskId }, select: { status: true, leaseOwner: true, triggerType: true } });
  assert(manual.triggerType === SyncTaskTriggerType.manual && manual.status === SyncTaskStatus.pending && manual.leaseOwner === null, 'manual task was unexpectedly claimed or modified');
}

async function assertOperations(high: LoginResult, incomeOnly: LoginResult, cardTaskId: string, lockedTaskId: string) {
  await expectStatus(incomeOnly.token, '/sync-tasks/operations', 200);
  await expectStatus(incomeOnly.token, `/sync-tasks/${cardTaskId}/request-retry`, 403, { method: 'POST', body: { reason: 'e2e denied' } });
  await expectStatus(incomeOnly.token, `/sync-tasks/${cardTaskId}/cancel`, 403, { method: 'POST', body: { reason: 'e2e denied' } });
  await expectMeAlive(incomeOnly.token, incomeOnly.actor.userId);
  await expectStatus(high.token, `/sync-tasks/${lockedTaskId}/request-retry`, 409, { method: 'POST', body: { reason: 'e2e locked month' } });
  await expectMeAlive(high.token, high.actor.userId);
}

async function assertAuditCenter(high: LoginResult, auditRead: LoginResult, auditExport: LoginResult, low: LoginResult, injectionAuditId: string) {
  const list = await expectStatus(auditRead.token, `/audit-logs?action=auth.test_formula&page=1&pageSize=20`, 200);
  const listBody = objectPayload(list);
  assert(Array.isArray(listBody.items), 'audit list did not return items');
  assert(listBody.items.some((item: any) => item.id === injectionAuditId), 'audit read user could not query seeded audit log');
  assertNoSensitiveTerms('audit list response', list.body);

  const detail = await expectStatus(auditRead.token, `/audit-logs/${injectionAuditId}`, 200);
  assertNoSensitiveTerms('audit detail response', detail.body);
  const detailBody = objectPayload(detail);
  assert(detailBody.module === 'auth', `expected auth module, got ${detailBody.module}`);
  assert(typeof detailBody.requestPayloadSummary === 'string', 'audit detail missing requestPayloadSummary');

  const historicalSensitive = await prisma.auditLog.create({
    data: {
      actorUserId: high.actor.userId,
      actorRole: high.actor.roleCode,
      action: 'auth.historical_sensitive',
      objectType: 'admin_user',
      result: AuditResult.success,
      requestPayload: { token: 'raw-history-token', text: 'Bearer raw-history-bearer apiKey=raw-history-key' },
      afterData: { password: 'raw-history-password', clientSecret: 'raw-history-secret' },
    },
  });
  const historicalDetail = await expectStatus(auditRead.token, `/audit-logs/${historicalSensitive.id}`, 200);
  assertNoSensitiveTerms('historical sensitive audit detail response', historicalDetail.body);
  await prisma.auditLog.delete({ where: { id: historicalSensitive.id } });

  await expectStatus(auditRead.token, '/audit-logs/export.csv?action=auth.test_formula', 403);
  await expectMeAlive(auditRead.token, auditRead.actor.userId);

  await expectStatus(low.token, '/audit-logs', 403);
  await expectMeAlive(low.token, low.actor.userId);

  const exported = await rawApiText('/audit-logs/export.csv?action=auth.test_formula', { token: auditExport.token });
  assert(exported.status === 200, `audit export expected 200, got ${exported.status}`);
  assert(exported.hasBom, 'audit export CSV missing UTF-8 BOM');
  assert(exported.text.includes(`"${injectionAuditId}"`), 'audit export CSV missing seeded audit log');
  assert(exported.text.includes('"\'=cmd"'), 'audit export CSV did not protect formula objectId');
  assertNoSensitiveTerms('audit export csv', exported.text);
  await expectMeAlive(auditExport.token, auditExport.actor.userId);

  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
      void Promise.all(message.args().map(async (arg) => {
        try {
          return JSON.stringify(await arg.jsonValue());
        } catch {
          return String(arg);
        }
      })).then((values) => {
        if (values.length) consoleMessages.push(`${message.type()} args: ${values.join(' | ')}`);
      }).catch(() => undefined);
    }
  });
  page.on('pageerror', (error) => {
    consoleMessages.push(`pageerror: ${error.message}`);
  });
  try {
    await page.goto(`${webUrl}/login`);
    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: high.token, actor: high.actor });
    await page.goto(`${webUrl}/audit-logs`);
    await page.getByRole('heading', { name: '审计中心' }).waitFor({ timeout: 20_000 });
    await page.getByLabel('动作').fill('auth.test_formula');
    await page.locator('button[type="submit"]').click();
    await page.getByText('auth.test_formula').first().waitFor({ timeout: 20_000 });
    const exportResponsePromise = page.waitForResponse((response) => response.url().includes('/audit-logs/export.csv') && response.status() === 200);
    await page.getByRole('button', { name: /导出 CSV/ }).click();
    await page.locator('.ant-modal-confirm').waitFor({ timeout: 10_000 });
    await page.locator('.ant-modal-confirm-btns .ant-btn-primary').click();
    const exportResponse = await exportResponsePromise;
    const disposition = exportResponse.headers()['content-disposition'] ?? '';
    assert(/audit-logs-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv/.test(disposition), `unexpected audit export content-disposition: ${disposition}`);
    const downloadedBytes = await exportResponse.body();
    assertNoSensitiveTerms('browser audit export csv', downloadedBytes.toString('utf8'));
    await page.getByRole('button', { name: '详情' }).first().click();
    await page.getByText('审计日志详情').waitFor({ timeout: 10_000 });
    const bodyText = await page.locator('body').innerText();
    assertNoSensitiveTerms('audit center page text', bodyText);
    await page.reload();
    await page.getByRole('heading', { name: '审计中心' }).waitFor({ timeout: 20_000 });
    const tokenAfterRefresh = await page.evaluate(() => window.sessionStorage.getItem('salary_admin_session_token'));
    assert(tokenAfterRefresh === high.token, 'audit center refresh did not keep session');
    const relevantConsoleMessages = consoleMessages.filter((message) => (
      !/favicon/i.test(message)
      && !/Failed to load resource: the server responded with a status of (403|404)/i.test(message)
    ));
    assert(relevantConsoleMessages.length === 0, `audit center browser console had warnings/errors: ${relevantConsoleMessages.join(' | ')}`);

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: auditRead.token, actor: auditRead.actor });
    await page.goto(`${webUrl}/audit-logs`);
    await page.getByRole('heading', { name: '审计中心' }).waitFor({ timeout: 20_000 });
    assert(await page.getByRole('button', { name: '导出 CSV' }).count() === 0, 'read-only audit user should not see export button');

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: low.token, actor: low.actor });
    await page.goto(`${webUrl}/audit-logs`);
    await page.locator('.ant-result-403').waitFor({ timeout: 20_000 });
    const lowMe = await page.evaluate(async (base) => {
      const stored = window.sessionStorage.getItem('salary_admin_session_token');
      const response = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${stored}` } });
      return response.status;
    }, apiUrl);
    assert(lowMe === 200, 'low audit browser session was cleared after 403');
  } finally {
    await context.close();
    await browser.close();
  }
}

async function assertBrowserSameSession403(incomeOnly: LoginResult, cardTaskId: string, month: Date): Promise<LoginResult> {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  try {
    await page.goto(`${webUrl}/login`);
    await page.getByLabel('用户名').fill(incomeOnlyUsername());
    await page.getByLabel('密码').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => window.sessionStorage.getItem('salary_admin_session_token') !== null, undefined, { timeout: 15_000 })
      .catch(async () => {
        const bodyText = (await page.locator('body').innerText()).slice(0, 500);
        throw new Error(`browser login did not establish a session; url=${page.url()}; body=${bodyText}`);
      });
    await page.goto(`${webUrl}/data-sync`);
    await page.getByText('同步执行运行台').waitFor({ timeout: 20_000 });
    await page.getByLabel('结算月份').fill(month.toISOString().slice(0, 7));
    await page.getByText(cardTaskId).waitFor({ timeout: 20_000 });
    const row = page.locator('tr').filter({ hasText: cardTaskId }).first();
    const buttons = row.locator('button');
    await buttons.nth(1).waitFor({ timeout: 10_000 });
    const buttonCount = await buttons.count();
    assert(await buttons.nth(1).isDisabled(), 'retry button should be disabled for card_spend without manual_card_spend.manage');
    if (buttonCount > 2) {
      assert(await buttons.nth(2).isDisabled(), 'cancel button should be disabled for card_spend without manual_card_spend.manage');
    }

    const retryStatus = await page.evaluate(async ({ apiUrl: base, taskId }) => {
      const stored = window.sessionStorage.getItem('salary_admin_session_token');
      const response = await fetch(`${base}/sync-tasks/${taskId}/request-retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${stored}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'same browser session e2e' }),
      });
      return response.status;
    }, { apiUrl, taskId: cardTaskId });
    assert(retryStatus === 403, `same browser context request-retry expected 403, got ${retryStatus}`);

    const me = await page.evaluate(async (base) => {
      const stored = window.sessionStorage.getItem('salary_admin_session_token');
      const response = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${stored}` } });
      const body = await response.json();
      return { status: response.status, userId: body.actor?.userId };
    }, apiUrl);
    assert(me.status === 200 && me.userId === incomeOnly.actor.userId, 'same browser context /me did not remain authenticated as low-permission user');

    await page.reload();
    await page.getByText('同步执行运行台').waitFor({ timeout: 20_000 });
    assert(!page.url().endsWith('/login'), 'page navigated to login after 403');
    const text = await page.locator('body').innerText();
    assertNoSensitiveTerms('data-sync page text', text);
    const relevantConsoleMessages = consoleMessages.filter((message) => (
      !/favicon/i.test(message)
      && !/Failed to load resource: the server responded with a status of (403|404)/i.test(message)
    ));
    assert(relevantConsoleMessages.length === 0, `browser console had warnings/errors: ${relevantConsoleMessages.join(' | ')}`);
    const token = await page.evaluate(() => window.sessionStorage.getItem('salary_admin_session_token'));
    assert(typeof token === 'string' && token.length > 0, 'browser session token was not available after login');
    return { token, actor: incomeOnly.actor };
  } finally {
    await browser.close();
  }
}

async function assertSystemHealthCenter(high: LoginResult, low: LoginResult) {
  const api = await expectStatus(high.token, '/system-health', 200);
  const apiBody = objectPayload(api);
  assert(['ok', 'warning', 'critical'].includes(apiBody.status), `unexpected system health status: ${apiBody.status}`);
  assert(Array.isArray(apiBody.checks), 'system health checks missing');
  assert('database' in apiBody && 'autoExecution' in apiBody && 'credentials' in apiBody, 'system health response missing core sections');
  assertNoSensitiveTerms('system health api response', api.body);

  await expectStatus(low.token, '/system-health', 403);
  await expectMeAlive(low.token, low.actor.userId);

  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  try {
    await page.goto(`${webUrl}/login`);
    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: high.token, actor: high.actor });
    await page.goto(`${webUrl}/system-health`);
    try {
      await page.getByTestId('system-health-page').waitFor({ timeout: 20_000 });
      await page.getByTestId('system-health-summary').waitFor({ timeout: 20_000 });
    } catch (error) {
      const rootHtml = await page.locator('#root').evaluate((node) => node.outerHTML).catch(async () => page.content());
      throw new Error(`system health page did not render shell; root=${rootHtml.slice(0, 12000)}; console=${consoleMessages.join(' | ')}`);
    }
    for (const testId of ['system-health-section-environment', 'system-health-section-database', 'system-health-section-autoExecution', 'system-health-section-credentials', 'system-health-section-settlements', 'system-health-section-audit', 'system-health-section-e2e', 'system-health-checks']) {
      try {
        await page.getByTestId(testId).waitFor({ timeout: 20_000 });
      } catch (error) {
        const rootHtml = await page.locator('#root').evaluate((node) => node.outerHTML).catch(async () => page.content());
        throw new Error(`system health page missing test id ${testId}; root=${rootHtml.slice(0, 12000)}; console=${consoleMessages.join(' | ')}`);
      }
    }
    await page.getByTestId('system-health-refresh').click();
    await page.waitForTimeout(1_000);
    await page.getByTestId('system-health-incidents').waitFor({ timeout: 20_000 });
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (bodyText) assertNoSensitiveTerms('system health page text', bodyText);
    await page.reload();
    await page.getByRole('heading', { name: '系统健康 / 运维中心' }).waitFor({ timeout: 20_000 });
    const tokenAfterRefresh = await page.evaluate(() => window.sessionStorage.getItem('salary_admin_session_token'));
    assert(tokenAfterRefresh === high.token, 'system health refresh did not keep session');

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: low.token, actor: low.actor });
    await page.goto(`${webUrl}/dashboard`);
    await page.waitForLoadState('networkidle');
    const lowMenuText = await page.locator('.admin-sider').innerText();
    assert(!lowMenuText.includes('系统健康'), 'low-permission user should not see system health menu');
    const lowStatus = await page.evaluate(async (base) => {
      const stored = window.sessionStorage.getItem('salary_admin_session_token');
      const denied = await fetch(`${base}/system-health`, { headers: { Authorization: `Bearer ${stored}` } });
      const me = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${stored}` } });
      return { denied: denied.status, me: me.status };
    }, apiUrl);
    assert(lowStatus.denied === 403, `low system-health API expected 403, got ${lowStatus.denied}`);
    assert(lowStatus.me === 200, 'low system-health 403 cleared session');

    const relevantConsoleMessages = consoleMessages.filter((message) => (
      !/favicon/i.test(message)
      && !/Failed to load resource: the server responded with a status of (403|404)/i.test(message)
    ));
    assert(relevantConsoleMessages.length === 0, `system health browser console had warnings/errors: ${relevantConsoleMessages.join(' | ')}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function assertAlertsCenter(high: LoginResult, low: LoginResult, fixture: Fixture) {
  await expectStatus(low.token, '/alerts', 403);
  await expectMeAlive(low.token, low.actor.userId);

  const beforeAlertIds = new Set((await prisma.alert.findMany({ select: { id: true } })).map((item) => item.id));
  const beforeUnread = objectPayload(await expectStatus(high.token, '/notifications/unread-count', 200)).count;
  const scan = await expectStatus(high.token, '/alerts/scan', 201, { method: 'POST' });
  const scanBody = objectPayload(scan);
  assert(scanBody.generated + scanBody.reactivated + scanBody.updated >= 1, 'alert scan did not process any alert');
  assert(scanBody.notificationsCreated >= 1, 'alert scan did not create any notification');

  const alerts = await expectStatus(high.token, '/alerts?status=active&page=1&pageSize=20', 200);
  const alertItems = objectPayload(alerts).items;
  assert(Array.isArray(alertItems) && alertItems.length > 0, 'alerts list returned no active alerts');
  assertNoSensitiveTerms('alerts api response', alerts.body);
  const alertId = alertItems[0].id;

  const unread = objectPayload(await expectStatus(high.token, '/notifications/unread-count', 200)).count;
  assert(unread >= beforeUnread, 'notification unread count did not stay monotonic after scan');
  const notifications = await expectStatus(high.token, '/notifications?unreadOnly=true&page=1&pageSize=20', 200);
  const notificationItems = objectPayload(notifications).items;
  assert(Array.isArray(notificationItems) && notificationItems.length > 0, 'notifications list returned no unread notifications');
  assertNoSensitiveTerms('notifications api response', notifications.body);
  await expectStatus(high.token, `/notifications/${notificationItems[0].id}/read`, 201, { method: 'POST' });
  await expectStatus(high.token, '/notifications/read-all', 201, { method: 'POST' });

  await expectStatus(low.token, `/alerts/${alertId}/acknowledge`, 403, { method: 'POST' });
  await expectMeAlive(low.token, low.actor.userId);
  await expectStatus(high.token, `/alerts/${alertId}/acknowledge`, 201, { method: 'POST' });
  fixture.createdAlertIds.push(...(await prisma.alert.findMany({ select: { id: true } }))
    .map((item) => item.id)
    .filter((id) => !beforeAlertIds.has(id)));

  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  try {
    await page.goto(`${webUrl}/login`);
    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: high.token, actor: high.actor });
    await page.goto(`${webUrl}/alerts`);
    await page.getByRole('heading', { name: '告警中心' }).waitFor({ timeout: 20_000 });
    await page.getByTestId('alerts-scan').click();
    await page.waitForTimeout(1_000);
    const detailButton = page.getByText(/详\s*情/).first();
    await detailButton.waitFor({ timeout: 20_000 }).catch(async () => {
      const body = await page.locator('body').innerText().catch(() => '');
      throw new Error(`alerts page did not show detail button; url=${page.url()}; body=${body.slice(0, 2000)}; console=${consoleMessages.join(' | ')}`);
    });
    await detailButton.click();
    await page.getByText('告警详情').waitFor({ timeout: 10_000 });
    const bodyText = await page.locator('body').innerText();
    assertNoSensitiveTerms('alerts page text', bodyText);
    await page.reload();
    await page.getByRole('heading', { name: '告警中心' }).waitFor({ timeout: 20_000 });
    const tokenAfterRefresh = await page.evaluate(() => window.sessionStorage.getItem('salary_admin_session_token'));
    assert(tokenAfterRefresh === high.token, 'alerts refresh did not keep session');

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: low.token, actor: low.actor });
    await page.goto(`${webUrl}/dashboard`);
    await page.waitForLoadState('networkidle');
    const lowMenuText = await page.locator('.admin-sider').innerText();
    assert(!lowMenuText.includes('告警中心'), 'low-permission user should not see alerts menu');
    const lowStatus = await page.evaluate(async (base) => {
      const stored = window.sessionStorage.getItem('salary_admin_session_token');
      const denied = await fetch(`${base}/alerts`, { headers: { Authorization: `Bearer ${stored}` } });
      const me = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${stored}` } });
      return { denied: denied.status, me: me.status };
    }, apiUrl);
    assert(lowStatus.denied === 403, `low alerts API expected 403, got ${lowStatus.denied}`);
    assert(lowStatus.me === 200, 'low alerts 403 cleared session');

    const relevantConsoleMessages = consoleMessages.filter((message) => (
      !/favicon/i.test(message)
      && !/Failed to load resource: the server responded with a status of (403|404)/i.test(message)
    ));
    assert(relevantConsoleMessages.length === 0, `alerts browser console had warnings/errors: ${relevantConsoleMessages.join(' | ')}`);
  } finally {
    await context.close();
    await browser.close();
  }
  await expectStatus(high.token, `/alerts/${alertId}/silence`, 201, { method: 'POST', body: { minutes: 60 } });
}

async function assertBackupRecoveryCenter(
  high: LoginResult,
  backupRead: LoginResult,
  backupManage: LoginResult,
  low: LoginResult,
  fixture: Fixture,
) {
  await expectStatus(low.token, '/backup-records', 403);
  await expectStatus(low.token, '/restore-drills', 403);
  await expectStatus(low.token, '/backup-health', 403);
  await expectMeAlive(low.token, low.actor.userId);

  await expectStatus(backupRead.token, '/backup-records?page=1&pageSize=5', 200);
  await expectStatus(backupRead.token, '/restore-drills?page=1&pageSize=5', 200);
  await expectStatus(backupRead.token, '/backup-records', 403, { method: 'POST', body: backupPayload('read-denied') });
  await expectStatus(backupRead.token, '/restore-drills', 403, { method: 'POST', body: drillPayload('read-denied', null) });
  await expectMeAlive(backupRead.token, backupRead.actor.userId);

  const backup = objectPayload(await expectStatus(backupManage.token, '/backup-records', 201, { method: 'POST', body: backupPayload('failed') }));
  const drill = objectPayload(await expectStatus(backupManage.token, '/restore-drills', 201, { method: 'POST', body: drillPayload('failed', backup.backupKey) }));
  fixture.backupRecordIds.push(backup.id);
  fixture.restoreDrillIds.push(drill.id);
  assert(backup.status === BackupStatus.failed, 'manage user did not create failed backup record');
  assert(drill.status === RestoreDrillStatus.failed, 'manage user did not create failed restore drill record');

  await expectStatus(backupManage.token, `/backup-records/${backup.id}`, 200);
  await expectStatus(backupManage.token, `/restore-drills/${drill.id}`, 200);
  await expectStatus(backupManage.token, `/backup-records/${backup.id}`, 200, { method: 'PATCH', body: { failureReason: 'safe failure summary', safeMetadata: { checked: true } } });
  await expectStatus(backupManage.token, `/restore-drills/${drill.id}`, 200, { method: 'PATCH', body: { failureReason: 'safe drill failure', safeMetadata: { checked: true } } });
  await expectStatus(backupManage.token, '/backup-records', 400, { method: 'POST', body: { ...backupPayload('unsafe'), storageAlias: 's3://bucket/file.dump' } });
  await expectStatus(backupManage.token, '/restore-drills', 400, { method: 'POST', body: { ...drillPayload('unsafe', backup.backupKey), safeMetadata: { token: 'x' } } });

  const health = objectPayload(await expectStatus(backupRead.token, '/backup-health', 200));
  assert(['ok', 'warning', 'critical'].includes(health.status), `unexpected backup health status: ${health.status}`);
  assert(Array.isArray(health.checks), 'backup health checks missing');
  assertNoSensitiveTerms('backup health api response', health);

  const beforeAlertIds = new Set((await prisma.alert.findMany({ select: { id: true } })).map((item) => item.id));
  const scan = objectPayload(await expectStatus(backupManage.token, '/alerts/scan', 201, { method: 'POST' }));
  assert(scan.generated + scan.reactivated + scan.updated >= 1, 'backup alert scan did not process any alert');
  const backupAlerts = await prisma.alert.findMany({ where: { fingerprint: { startsWith: 'backup-recovery:' } } });
  assert(backupAlerts.length >= 1, 'backup alert scan did not create backup-recovery alert');
  fixture.createdAlertIds.push(...backupAlerts.map((item) => item.id).filter((id) => !beforeAlertIds.has(id)));
  assertNoSensitiveTerms('backup alert rows', backupAlerts);

  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  try {
    await page.goto(`${webUrl}/login`);
    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: high.token, actor: high.actor });
    await page.goto(`${webUrl}/backup-recovery`);
    await page.getByTestId('backup-recovery-page').waitFor({ timeout: 20_000 });
    await page.getByTestId('backup-health-summary').waitFor({ timeout: 20_000 });
    await page.getByRole('heading', { name: '数据保全 / 备份恢复' }).waitFor({ timeout: 20_000 });
    await page.getByText('备份健康摘要').waitFor({ timeout: 20_000 });
    const detailButton = page.getByText(/详\s*情/).first();
    await detailButton.waitFor({ timeout: 20_000 }).catch(async () => {
      const body = await page.locator('body').innerText().catch(() => '');
      throw new Error(`backup recovery page did not show detail button; body=${body.slice(0, 2000)}; console=${consoleMessages.join(' | ')}`);
    });
    await detailButton.click();
    await page.getByText('记录详情').waitFor({ timeout: 10_000 });
    assertNoSensitiveTerms('backup recovery page text', await page.locator('body').innerText());

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: backupRead.token, actor: backupRead.actor });
    await page.goto(`${webUrl}/backup-recovery`);
    await page.getByTestId('backup-recovery-page').waitFor({ timeout: 20_000 });
    const readText = await page.locator('body').innerText();
    assert(!readText.includes('新增备份记录') && !readText.includes('新增恢复演练'), 'read-only user should not see create buttons');

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: low.token, actor: low.actor });
    await page.goto(`${webUrl}/dashboard`);
    await page.waitForLoadState('networkidle');
    const lowMenuText = await page.locator('.admin-sider').innerText();
    assert(!lowMenuText.includes('数据保全'), 'low-permission user should not see backup recovery menu');
    const lowStatus = await page.evaluate(async (base) => {
      const stored = window.sessionStorage.getItem('salary_admin_session_token');
      const denied = await fetch(`${base}/backup-records`, { headers: { Authorization: `Bearer ${stored}` } });
      const me = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${stored}` } });
      return { denied: denied.status, me: me.status };
    }, apiUrl);
    assert(lowStatus.denied === 403, `low backup API expected 403, got ${lowStatus.denied}`);
    assert(lowStatus.me === 200, 'low backup API 403 cleared session');

    const relevantConsoleMessages = consoleMessages.filter((message) => (
      !/favicon/i.test(message)
      && !/Failed to load resource: the server responded with a status of (403|404)/i.test(message)
    ));
    assert(relevantConsoleMessages.length === 0, `backup recovery browser console had warnings/errors: ${relevantConsoleMessages.join(' | ')}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

function backupPayload(suffix: string) {
  return {
    backupKey: `${runPrefix}_backup_${suffix}`,
    status: BackupStatus.failed,
    backupType: BackupType.full,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    storageAlias: 'primary-offsite',
    fileSizeBytes: '4096',
    checksumSha256: null,
    encrypted: false,
    encryptionAlias: null,
    scopeSummary: { tables: ['admin_users', 'audit_logs', 'sync_tasks'] },
    safeMetadata: { source: 'e2e-permissions', run: runPrefix },
    failureReason: 'safe e2e failure summary',
  };
}

function drillPayload(suffix: string, backupKey: string | null) {
  return {
    drillKey: `${runPrefix}_drill_${suffix}`,
    status: RestoreDrillStatus.failed,
    environmentAlias: 'restore-ci',
    backupKey,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    validationSummary: { checks: ['admin_users', 'audit_logs', 'sync_tasks'] },
    safeMetadata: { source: 'e2e-permissions', run: runPrefix },
    failureReason: 'safe e2e drill failure',
  };
}

async function assertReleaseGateCenter(high: LoginResult, releaseRead: LoginResult, releaseRun: LoginResult, low: LoginResult) {
  await expectStatus(low.token, '/release-gate', 403);
  await expectStatus(low.token, '/release-gate/run', 403, { method: 'POST' });
  await expectMeAlive(low.token, low.actor.userId);

  const readResult = objectPayload(await expectStatus(releaseRead.token, '/release-gate', 200));
  assert(['pass', 'warning', 'fail'].includes(readResult.status), `unexpected release gate status: ${readResult.status}`);
  assert(Array.isArray(readResult.checks), 'release gate checks missing');
  assert(readResult.checks.some((item: any) => item.severity === 'required'), 'release gate required checks missing');
  assert(readResult.checks.some((item: any) => item.severity === 'recommended'), 'release gate recommended checks missing');
  await expectStatus(releaseRead.token, '/release-gate/run', 403, { method: 'POST' });
  await expectMeAlive(releaseRead.token, releaseRead.actor.userId);

  const runResult = objectPayload(await expectStatus(releaseRun.token, '/release-gate/run', 201, { method: 'POST' }));
  assert(['pass', 'warning', 'fail'].includes(runResult.status), `unexpected release gate run status: ${runResult.status}`);
  assertNoSensitiveTerms('release gate run response', runResult);
  const runAudit = await prisma.auditLog.findFirst({ where: { action: 'release_gate.run', actorUserId: releaseRun.actor.userId }, orderBy: { createdAt: 'desc' } });
  assert(runAudit, 'release gate run audit was not written');
  assertNoSensitiveTerms('release gate run audit', runAudit);

  const browser = await launchBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  try {
    await page.goto(`${webUrl}/login`);
    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: high.token, actor: high.actor });
    await page.goto(`${webUrl}/release-gate`);
    await page.getByTestId('release-gate-page').waitFor({ timeout: 20_000 });
    await page.getByText('总体状态').waitFor({ timeout: 20_000 });
    await page.getByTestId('release-gate-required').waitFor({ timeout: 20_000 });
    await page.getByTestId('release-gate-recommended').waitFor({ timeout: 20_000 });
    await page.getByTestId('release-gate-run').click();
    await page.getByText('修复建议').waitFor({ timeout: 20_000 });
    assertNoSensitiveTerms('release gate page text', await page.locator('body').innerText());

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: releaseRead.token, actor: releaseRead.actor });
    await page.goto(`${webUrl}/release-gate`);
    await page.getByTestId('release-gate-page').waitFor({ timeout: 20_000 });
    const readText = await page.locator('body').innerText();
    assert(!readText.includes('运行检查'), 'release_gate.read user should not see run button');

    await page.evaluate(({ token, actor }) => {
      window.sessionStorage.setItem('salary_admin_session_token', token);
      window.sessionStorage.setItem('salary_admin_actor', JSON.stringify(actor));
    }, { token: low.token, actor: low.actor });
    await page.goto(`${webUrl}/dashboard`);
    await page.waitForLoadState('networkidle');
    const lowMenuText = await page.locator('.admin-sider').innerText();
    assert(!lowMenuText.includes('发布门禁'), 'low-permission user should not see release gate menu');
    const lowStatus = await page.evaluate(async (base) => {
      const stored = window.sessionStorage.getItem('salary_admin_session_token');
      const denied = await fetch(`${base}/release-gate`, { headers: { Authorization: `Bearer ${stored}` } });
      const me = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${stored}` } });
      return { denied: denied.status, me: me.status };
    }, apiUrl);
    assert(lowStatus.denied === 403, `low release gate API expected 403, got ${lowStatus.denied}`);
    assert(lowStatus.me === 200, 'low release gate API 403 cleared session');

    const relevantConsoleMessages = consoleMessages.filter((message) => (
      !/favicon/i.test(message)
      && !/Failed to load resource: the server responded with a status of (403|404)/i.test(message)
    ));
    assert(relevantConsoleMessages.length === 0, `release gate browser console had warnings/errors: ${relevantConsoleMessages.join(' | ')}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function assertSensitiveRuntimeSurfaces(startedAt: Date, userIds: string[], high: LoginResult) {
  const responses = [
    await expectStatus(high.token, '/me', 200),
    await expectStatus(high.token, '/admin-users', 200),
    await expectStatus(high.token, '/roles', 200),
    await expectStatus(high.token, '/dashboard/overview', 200),
    await expectStatus(high.token, '/sync-tasks/operations', 200),
    await expectStatus(high.token, '/system-health', 200),
    await expectStatus(high.token, '/alerts', 200),
    await expectStatus(high.token, '/backup-health', 200),
    await expectStatus(high.token, '/backup-records', 200),
    await expectStatus(high.token, '/restore-drills', 200),
    await expectStatus(high.token, '/release-gate', 200),
    await expectStatus(high.token, '/notifications', 200),
  ];
  responses.forEach((response, index) => assertNoSensitiveTerms(`api response ${index + 1}`, response.body));
  const audits = await prisma.auditLog.findMany({
    where: {
      createdAt: { gte: startedAt },
      actorUserId: { in: userIds },
    },
    orderBy: { createdAt: 'asc' },
  });
  assertNoSensitiveTerms('audit logs', audits);
}

async function login(username: string): Promise<LoginResult> {
  let response = await rawApi('/auth/login', { method: 'POST', body: { username, password } });
  if (response.status === 429) {
    await sleep(61_000);
    response = await rawApi('/auth/login', { method: 'POST', body: { username, password } });
  }
  assert(response.status === 201 || response.status === 200, `login failed for ${username}: ${response.status}`);
  const body = objectPayload(response);
  assert(typeof body.token === 'string', `login for ${username} did not return a token`);
  return body as LoginResult;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawApi(path: string, options: { method?: string; token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function rawApiText(path: string, options: { method?: string; token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(bytes);
  return { status: response.status, text, headers: response.headers, hasBom: bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF };
}

async function expectStatus(token: string, path: string, status: number, options: { method?: string; body?: unknown } = {}) {
  const response = await rawApi(path, { ...options, token });
  assert(response.status === status, `${path} expected ${status}, got ${response.status}`);
  if (status !== 401) assertNoSensitiveTerms(`${path} response`, response.body);
  return response;
}

async function expectMeAlive(token: string, userId: string) {
  const response = await expectStatus(token, '/me', 200);
  assert(objectPayload(response).actor?.userId === userId, '/me returned a different actor after permission denial');
}

async function launchBrowser(): Promise<Browser> {
  const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
  try {
    return await chromium.launch({ channel, headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

function incomeOnlyUsername() {
  return `${runPrefix}_income_only`;
}

async function cleanupFixture(fixture: Fixture | null, startedAt: Date) {
  if (!fixture) return 'no fixture created';
  const taskIds = Object.values(fixture.tasks).map((task) => task.id);
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: fixture.userIds } },
        { objectId: { in: [...taskIds, ...fixture.userIds, ...fixture.roleIds, fixture.otherSessionId] } },
        { objectId: { startsWith: runPrefix } },
      ],
    },
  });
  await prisma.notification.deleteMany({ where: { OR: [{ recipientId: { in: fixture.userIds } }, { alertId: { in: fixture.createdAlertIds } }] } });
  await prisma.alert.deleteMany({ where: { id: { in: fixture.createdAlertIds } } });
  await prisma.restoreDrillRecord.deleteMany({ where: { OR: [{ id: { in: fixture.restoreDrillIds } }, { drillKey: { startsWith: runPrefix } }] } });
  await prisma.backupRecord.deleteMany({ where: { OR: [{ id: { in: fixture.backupRecordIds } }, { backupKey: { startsWith: runPrefix } }] } });
  await prisma.adminSession.deleteMany({ where: { OR: [{ adminUserId: { in: fixture.userIds } }, { id: fixture.otherSessionId }] } });
  await prisma.syncUnmatchedEvent.deleteMany({ where: { syncTaskId: { in: taskIds } } });
  await prisma.syncTask.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.monthlySettlement.deleteMany({ where: { settlementMonth: { in: [fixture.lockedMonth] } } });
  await prisma.incomeRecord.deleteMany({ where: { affiliateAccountId: fixture.cakeAccountId } });
  await prisma.subIdMapping.deleteMany({ where: { affiliateAccountId: fixture.cakeAccountId } });
  await prisma.affiliateAccountCredential.deleteMany({ where: { id: fixture.affiliateCredentialId } });
  await prisma.affiliateAccount.deleteMany({ where: { id: { in: [fixture.affiliateAccountId, fixture.cakeAccountId] } } });
  await prisma.adminUserRole.deleteMany({ where: { OR: [{ adminUserId: { in: fixture.userIds } }, { roleId: { in: fixture.roleIds } }] } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: fixture.roleIds } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: fixture.userIds } } });
  await prisma.role.deleteMany({ where: { id: { in: fixture.roleIds } } });
  await prisma.employee.deleteMany({ where: { id: fixture.employeeId } });
  await prisma.alert.deleteMany({
    where: {
      OR: taskIds.map((id) => ({ fingerprint: { startsWith: `sync-task:${id}:` } })),
    },
  });
  await prisma.alert.updateMany({
    where: {
      status: { in: [AlertStatus.active, AlertStatus.silenced] },
      lastSeenAt: { gte: startedAt },
      OR: [
        { fingerprint: 'system-health:DATA_PROTECTION_BACKUP_HEALTH' },
        { fingerprint: 'system-health:DATA_PROTECTION_BACKUP_LATEST_FAILED' },
      ],
    },
    data: {
      status: AlertStatus.resolved,
      resolvedAt: new Date(),
      silencedUntil: null,
    },
  });
  const remaining = await prisma.adminUser.count({ where: { username: { startsWith: runPrefix } } })
    + await prisma.role.count({ where: { code: { startsWith: runPrefix } } })
    + await prisma.syncTask.count({ where: { id: { in: taskIds } } })
    + await prisma.incomeRecord.count({ where: { id: { in: [fixture.cakeBaseIncomeId, ...fixture.cakeAdjustmentIds] } } })
    + await prisma.backupRecord.count({ where: { backupKey: { startsWith: runPrefix } } })
    + await prisma.restoreDrillRecord.count({ where: { drillKey: { startsWith: runPrefix } } })
    + await prisma.auditLog.count({ where: { actorUserId: { in: fixture.userIds } } })
    + await prisma.alert.count({ where: { OR: taskIds.map((id) => ({ fingerprint: { startsWith: `sync-task:${id}:` } })) } });
  assert(remaining === 0, `cleanup left ${remaining} test records`);
  return 'remaining test records = 0';
}

async function nextUnusedMonth(start: Date) {
  for (let offset = 0; offset < 120; offset++) {
    const candidate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
    const existing = await prisma.monthlySettlement.findUnique({ where: { settlementMonth: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw new Error('Could not find an unused future settlement month for E2E.');
}

function objectPayload(response: { body: unknown }): Record<string, any> {
  assert(typeof response.body === 'object' && response.body !== null && !Array.isArray(response.body), 'expected object response body');
  return response.body as Record<string, any>;
}

function assertNoSensitiveTerms(label: string, value: unknown) {
  const text = JSON.stringify(value);
  for (const term of forbiddenTerms) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    assert(!pattern.test(text), `${label} contains forbidden sensitive term: ${term}; paths=${sensitivePaths(value, pattern).join(',') || 'json-text'}`);
  }
}

function sensitivePaths(value: unknown, pattern: RegExp, path = '$', acc: string[] = []): string[] {
  if (acc.length >= 10) return acc;
  if (value === null || value === undefined) return acc;
  if (typeof value === 'string') {
    if (pattern.test(value)) acc.push(path);
    return acc;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return acc;
  if (Array.isArray(value)) {
    value.forEach((item, index) => sensitivePaths(item, pattern, `${path}[${index}]`, acc));
    return acc;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (pattern.test(key)) acc.push(`${path}.${key}`);
      sensitivePaths(child, pattern, `${path}.${key}`, acc);
      if (acc.length >= 10) break;
    }
  }
  return acc;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : 'E2E permissions failed.');
  await prisma.$disconnect();
  process.exit(1);
});
