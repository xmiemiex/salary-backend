import assert from 'node:assert/strict';
import {
  CARD_PROVIDER_OPTIONS,
  SYNC_OPTIONS,
  canExecuteStatus,
  credentialText,
  safeJsonText,
} from '../src/pages/data-sync-utils';
import { PHOTONPAY_DEFAULT_BASE_URL, photonPayDefaultFields } from '../src/pages/api-credentials-utils';
import {
  AFFILIATE_PLATFORM_OPTIONS,
  EMPLOYEE_SUMMARY_COLUMNS,
  UNMATCHED_LIMITATION_NOTICE,
  displaySyncTaskId,
} from '../src/pages/sync-reconciliation-utils';
import {
  buildSyncUnmatchedEventsQuery,
  isPendingUnmatchedEvent,
  rawSafeDataText,
  uiStatusFromApi,
} from '../src/pages/sync-unmatched-events-utils';
import {
  createLatestPreflightRequestGuard,
  buildSettlementGenerateBody,
  formatPreflightDetails,
  formatPreflightSummary,
  getGenerateDisabledReason,
  handleSettlementPrecheckFailure,
  isGenerateDisabled,
  parseSettlementPrecheckFailure,
  parseSettlementWarningAckFailure,
  shouldConfirmWarningGenerate,
  type SettlementPreflightResult,
} from '../src/pages/salary-settlement-utils';

const renderedPayload = safeJsonText({
  adapterKey: 'card_spend.airwallex',
  pulledThirdPartyData: true,
  successCount: 2,
  failedCount: 1,
  requestWindow: { from: '2026-05-31T16:00:00.000Z', to: '2026-07-10T16:00:00.000Z' },
  settlementWindow: { gmt8Month: '2026-06', from: '2026-05-31T16:00:00.000Z' },
  apiKey: 'plain-api-key',
  token: 'plain-token',
  secret: 'plain-secret',
  clientId: 'plain-client-id',
  nested: {
    merchantId: 'plain-merchant-id',
    authorization: 'Bearer plain-token',
    visible: 'kept',
  },
});

assert.match(renderedPayload, /requestWindow/);
assert.match(renderedPayload, /settlementWindow/);
assert.match(renderedPayload, /card_spend\.airwallex/);
assert.match(renderedPayload, /kept/);
assert.doesNotMatch(renderedPayload, /plain-api-key/);
assert.doesNotMatch(renderedPayload, /plain-token/);
assert.doesNotMatch(renderedPayload, /plain-secret/);
assert.doesNotMatch(renderedPayload, /plain-client-id/);
assert.doesNotMatch(renderedPayload, /plain-merchant-id/);
assert.doesNotMatch(renderedPayload, /apiKey/);
assert.doesNotMatch(renderedPayload, /token/);
assert.doesNotMatch(renderedPayload, /secret/);
assert.doesNotMatch(renderedPayload, /clientId/);

assert.equal(canExecuteStatus('running'), false);
assert.equal(canExecuteStatus('completed'), false);
assert.equal(canExecuteStatus('failed'), true);
assert.equal(canExecuteStatus('not_implemented'), true);

assert.equal(credentialText({ hasCredential: true, status: 'active' }), '已配置凭证');
assert.equal(credentialText({ hasCredential: true, status: 'disabled' }), '未配置凭证');
assert.equal(credentialText({ hasCredential: false }), '未配置凭证');

const optionLabels = SYNC_OPTIONS.map((option) => option.label).join(' ');
assert.doesNotMatch(optionLabels, /Blitz/i);
assert.ok(SYNC_OPTIONS.some((option) => option.value === 'affiliate_income' && option.endpoint === '/sync-tasks/affiliate-income'));

assert.deepEqual(
  CARD_PROVIDER_OPTIONS.map((option) => option.provider).sort(),
  ['airwallex', 'photonpay'],
);

assert.equal(PHOTONPAY_DEFAULT_BASE_URL, 'https://x-api.photonpay.com');
assert.equal(photonPayDefaultFields().find((field) => field.key === 'baseUrl')?.value, 'https://x-api.photonpay.com');

assert.deepEqual(
  AFFILIATE_PLATFORM_OPTIONS.map((option) => option.value),
  ['everflow', 'cake'],
);
assert.doesNotMatch(
  AFFILIATE_PLATFORM_OPTIONS.map((option) => `${option.label}:${option.value}`).join(' '),
  /Blitz/i,
);

assert.match(UNMATCHED_LIMITATION_NOTICE, /只显示未归属的收入\/卡记录/);
assert.match(UNMATCHED_LIMITATION_NOTICE, /同步未匹配事件/);

assert.equal(displaySyncTaskId(null), '无真实任务关联');
assert.equal(displaySyncTaskId(undefined), '无真实任务关联');
assert.equal(displaySyncTaskId(''), '无真实任务关联');
assert.equal(displaySyncTaskId('task-1'), 'task-1');
assert.notEqual(displaySyncTaskId(null), 'system_import');

const unmatchedQuery = buildSyncUnmatchedEventsQuery(
  {
    settlementMonth: '2026-06',
    sourceType: 'affiliate_income',
    platform: 'cake',
    provider: 'airwallex',
    reasonCode: 'SUB_ID_NOT_MAPPED',
    status: 'pending',
  },
  2,
  50,
);
assert.match(unmatchedQuery, /settlementMonth=2026-06/);
assert.match(unmatchedQuery, /sourceType=affiliate_income/);
assert.match(unmatchedQuery, /platform=cake/);
assert.match(unmatchedQuery, /provider=airwallex/);
assert.match(unmatchedQuery, /reasonCode=SUB_ID_NOT_MAPPED/);
assert.match(unmatchedQuery, /status=open/);
assert.match(unmatchedQuery, /page=2/);
assert.match(unmatchedQuery, /pageSize=50/);
assert.doesNotMatch(unmatchedQuery, /status=pending/);

assert.equal(uiStatusFromApi('open'), 'pending');
assert.equal(uiStatusFromApi('ignored'), 'ignored');
assert.equal(uiStatusFromApi('resolved'), 'resolved');

assert.equal(isPendingUnmatchedEvent({ status: 'open' }), true);
assert.equal(isPendingUnmatchedEvent({ status: 'pending' }), true);
assert.equal(isPendingUnmatchedEvent({ status: 'ignored' }), false);
assert.equal(isPendingUnmatchedEvent({ status: 'resolved' }), false);

const rawSafeData = rawSafeDataText({
  conversionId: 'conversion-1',
  sub1: 'employee-sub',
  apiKey: 'raw-api-key',
  token: 'raw-token',
  secret: 'raw-secret',
  clientId: 'raw-client-id',
  merchantId: 'raw-merchant-id',
  nested: {
    authorization: 'Bearer raw-token',
    visible: 'visible-value',
  },
});
assert.match(rawSafeData, /conversion-1/);
assert.match(rawSafeData, /employee-sub/);
assert.match(rawSafeData, /visible-value/);
assert.doesNotMatch(rawSafeData, /raw-api-key/);
assert.doesNotMatch(rawSafeData, /raw-token/);
assert.doesNotMatch(rawSafeData, /raw-secret/);
assert.doesNotMatch(rawSafeData, /raw-client-id/);
assert.doesNotMatch(rawSafeData, /raw-merchant-id/);

const blockingPreflight: Pick<SettlementPreflightResult, 'settlementMonth' | 'canGenerate' | 'severity'> = {
  settlementMonth: '2026-06',
  canGenerate: false,
  severity: 'blocking',
};
assert.equal(
  isGenerateDisabled({ hasGeneratePermission: true, isLocked: false, settlementMonth: '2026-06', preflight: blockingPreflight }),
  true,
);
assert.match(
  getGenerateDisabledReason({ hasGeneratePermission: true, isLocked: false, settlementMonth: '2026-06', preflight: blockingPreflight }) ?? '',
  /preflight/,
);

const warningPreflight: Pick<SettlementPreflightResult, 'settlementMonth' | 'canGenerate' | 'severity'> = {
  settlementMonth: '2026-06',
  canGenerate: true,
  severity: 'warning',
};
assert.equal(shouldConfirmWarningGenerate(warningPreflight), true);

const okPreflight: Pick<SettlementPreflightResult, 'settlementMonth' | 'canGenerate' | 'severity'> = {
  settlementMonth: '2026-06',
  canGenerate: true,
  severity: 'ok',
};
assert.equal(shouldConfirmWarningGenerate(okPreflight), false);
assert.equal(
  isGenerateDisabled({ hasGeneratePermission: true, isLocked: false, settlementMonth: '2026-06', preflight: okPreflight }),
  false,
);
assert.equal(
  isGenerateDisabled({ hasGeneratePermission: true, isLocked: false, settlementMonth: '2026-07', preflight: okPreflight }),
  true,
  '月份变化后旧 preflight 不能继续允许生成',
);

let guardedMonth = '2026-06';
const requestGuard = createLatestPreflightRequestGuard(() => guardedMonth);
const juneRequest = requestGuard.begin('2026-06');
guardedMonth = '2026-07';
const julyRequest = requestGuard.begin('2026-07');
let adoptedMonth: string | null = null;
if (requestGuard.isCurrent(julyRequest)) adoptedMonth = '2026-07';
if (requestGuard.isCurrent(juneRequest)) adoptedMonth = '2026-06';
assert.equal(adoptedMonth, '2026-07', '两次请求乱序返回时只采用最新月份结果');

let guardedError: string | null = null;
if (requestGuard.isCurrent(julyRequest)) guardedError = null;
if (requestGuard.isCurrent(juneRequest)) guardedError = '旧请求失败';
assert.equal(guardedError, null, '旧请求失败不能覆盖新请求成功状态');

const formattedPreflightSummary = formatPreflightSummary({
  openUnmatchedEventCount: 2,
  missingProviderFeeRateCount: 1,
  missingExchangeRate: true,
  draftManualRecordCount: 3,
  runningOrPendingSyncTaskCount: 4,
  isLocked: false,
});
assert.deepEqual(
  formattedPreflightSummary.map((item) => [item.key, item.value]),
  [
    ['openUnmatchedEventCount', '2'],
    ['missingProviderFeeRateCount', '1'],
    ['missingExchangeRate', '是'],
    ['draftManualRecordCount', '3'],
    ['runningOrPendingSyncTaskCount', '4'],
    ['isLocked', '否'],
  ],
);

const preflightDetails = formatPreflightDetails({
  missingProviders: ['airwallex'],
  apiKey: 'preflight-api-key',
  token: 'preflight-token',
  nested: { visible: 'visible-detail', secret: 'preflight-secret' },
});
assert.match(preflightDetails, /airwallex/);
assert.match(preflightDetails, /visible-detail/);
assert.doesNotMatch(preflightDetails, /preflight-api-key/);
assert.doesNotMatch(preflightDetails, /preflight-token/);
assert.doesNotMatch(preflightDetails, /preflight-secret/);
assert.doesNotMatch(preflightDetails, /apiKey/);
assert.doesNotMatch(preflightDetails, /token/);
assert.doesNotMatch(preflightDetails, /secret/);

const serverPrecheckError = Object.assign(new Error('blocked'), {
  code: 'SETTLEMENT_PRECHECK_FAILED',
  details: {
    settlementMonth: '2026-06',
    severity: 'blocking',
    blockingChecks: [
      {
        code: 'MISSING_EXCHANGE_RATE',
        message: '缺少月度汇率。',
        apiKey: 'check-api-key',
        token: 'check-token',
      },
      { code: 'MONTH_LOCKED', message: '月份已锁账。', secret: 'check-secret' },
      { code: 'INVALID_WITHOUT_MESSAGE' },
    ],
    apiKey: 'details-api-key',
    token: 'details-token',
    secret: 'details-secret',
    credential: 'details-credential',
    unknown: 'must-not-pass-through',
  },
});
const parsedServerPrecheck = parseSettlementPrecheckFailure(serverPrecheckError);
assert.deepEqual(parsedServerPrecheck, {
  kind: 'blocking',
  settlementMonth: '2026-06',
  severity: 'blocking',
  blockingChecks: [
    { code: 'MISSING_EXCHANGE_RATE', message: '缺少月度汇率。' },
    { code: 'MONTH_LOCKED', message: '月份已锁账。' },
  ],
});
assert.doesNotMatch(JSON.stringify(parsedServerPrecheck), /apiKey|token|secret|credential|unknown|must-not-pass-through/);
assert.equal(
  parseSettlementPrecheckFailure(Object.assign(new Error('validation'), { code: 'VALIDATION_ERROR' })),
  null,
  '普通错误不能进入 preflight blocking 分支',
);

const warningResult: SettlementPreflightResult = {
  settlementMonth: '2026-06',
  canGenerate: true,
  severity: 'warning',
  checks: [
    { code: 'OPEN_UNMATCHED_EVENTS', severity: 'warning', message: '存在未匹配事件。' },
    { code: 'DRAFT_MANUAL_RECORDS', severity: 'warning', message: '存在草稿。' },
  ],
  summary: {
    openUnmatchedEventCount: 1,
    missingProviderFeeRateCount: 0,
    missingExchangeRate: false,
    draftManualRecordCount: 1,
    runningOrPendingSyncTaskCount: 0,
    isLocked: false,
  },
};
const warningAcknowledgement = {
  settlementMonth: '2026-06',
  codes: ['OPEN_UNMATCHED_EVENTS', 'DRAFT_MANUAL_RECORDS'],
};
assert.deepEqual(
  buildSettlementGenerateBody({ 'employee-1': 'sick_leave' }, warningAcknowledgement, '2026-06', warningResult),
  {
    attendanceByEmployeeId: { 'employee-1': 'sick_leave' },
    acknowledgedWarningCodes: ['OPEN_UNMATCHED_EVENTS', 'DRAFT_MANUAL_RECORDS'],
  },
  'warning 明确确认后应提交当前全部 codes',
);
assert.deepEqual(
  buildSettlementGenerateBody({}, warningAcknowledgement, '2026-07', { ...warningResult, settlementMonth: '2026-07' }),
  { attendanceByEmployeeId: {} },
  '月份变化必须使旧确认失效',
);
assert.deepEqual(
  buildSettlementGenerateBody({}, warningAcknowledgement, '2026-06', {
    ...warningResult,
    checks: [{ code: 'NEW_WARNING', severity: 'warning', message: 'new' }],
  }),
  { attendanceByEmployeeId: {} },
  'warning codes 变化必须使旧确认失效',
);
assert.deepEqual(
  buildSettlementGenerateBody({}, warningAcknowledgement, '2026-06', { ...warningResult, severity: 'ok', checks: [] }),
  { attendanceByEmployeeId: {} },
  'ok 状态不能发送旧 warning codes',
);

const warningAckError = Object.assign(new Error('ack required'), {
  code: 'SETTLEMENT_WARNING_ACK_REQUIRED',
  details: {
    settlementMonth: '2026-06',
    requiredWarningCodes: ['NEW_WARNING'],
    acknowledgedWarningCodes: ['OLD_WARNING'],
    missingWarningCodes: ['NEW_WARNING'],
    unknownWarningCodes: ['OLD_WARNING'],
    secret: 'must-not-pass-through',
  },
});
assert.deepEqual(parseSettlementWarningAckFailure(warningAckError), {
  kind: 'warningAck',
  settlementMonth: '2026-06',
  requiredWarningCodes: ['NEW_WARNING'],
  acknowledgedWarningCodes: ['OLD_WARNING'],
  missingWarningCodes: ['NEW_WARNING'],
  unknownWarningCodes: ['OLD_WARNING'],
});

const attendanceRows = [{ employeeId: 'employee-1', attendanceStatus: 'sick_leave' }];
const attendanceSnapshot = structuredClone(attendanceRows);
let rejectionCount = 0;
let preflightRefreshCount = 0;
let generateRequestCount = 0;
async function testSettlementPrecheckFailureHandling() {
  let handledServerPrecheck = false;
  const submitGenerateSimulation = async () => {
    generateRequestCount += 1;
    try {
      throw warningAckError;
    } catch (error) {
      handledServerPrecheck = await handleSettlementPrecheckFailure(
        error,
        () => {
          rejectionCount += 1;
        },
        async () => {
          preflightRefreshCount += 1;
        },
      );
    }
  };
  await submitGenerateSimulation();
  assert.equal(handledServerPrecheck, true);
  assert.equal(rejectionCount, 1, '服务端拒绝后应展示一次阻断结果');
  assert.equal(preflightRefreshCount, 1, '服务端拒绝后应刷新一次 preflight');
  assert.deepEqual(attendanceRows, attendanceSnapshot, '刷新 preflight 不应清空用户填写的考勤数据');
  assert.equal(generateRequestCount, 1, '服务端拒绝后不得自动重试生成');

  const handledOrdinaryError = await handleSettlementPrecheckFailure(
    Object.assign(new Error('network'), { code: 'HTTP_500' }),
    () => {
      rejectionCount += 1;
    },
    async () => {
      preflightRefreshCount += 1;
    },
  );
  assert.equal(handledOrdinaryError, false);
  assert.equal(rejectionCount, 1);
  assert.equal(preflightRefreshCount, 1);
}

const employeeSummaryColumnText = EMPLOYEE_SUMMARY_COLUMNS.join(' ');
assert.doesNotMatch(employeeSummaryColumnText, /salary|commission|group|negative/i);
assert.doesNotMatch(employeeSummaryColumnText, /工资|提成|分组|负毛利/);
assert.match(employeeSummaryColumnText, /affiliateRevenueUsd/);
assert.match(employeeSummaryColumnText, /rawGrossProfitUsd/);

void testSettlementPrecheckFailureHandling().then(() => {
  console.log('data-sync-utils tests passed');
});
