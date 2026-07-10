import assert from 'node:assert/strict';
import {
  auditResultTag,
  buildAuditLogsExportQuery,
  buildAuditLogsQuery,
  canExportAuditLogs,
  createLatestRequestGuard,
  defaultAuditLogFilters,
  fallbackAuditLogsFilename,
  moduleLabel,
  parseSafeAsciiFilename,
  safeAuditJsonText,
  setupAuditLogRequestLifecycle,
  toIsoWithTimezone,
  triggerBlobDownload,
  validateAuditLogsRange,
} from '../src/pages/audit-log-utils';

const defaults = defaultAuditLogFilters(new Date('2026-07-07T12:00:00+08:00'));
assert.equal(defaults.createdFrom, '2026-06-30T12:00');
assert.equal(defaults.createdTo, '2026-07-07T12:00');

const query = buildAuditLogsQuery({
  ...defaults,
  action: ' auth.login ',
  module: 'auth',
  actorUsername: ' admin ',
  objectType: '',
  result: 'success',
  requestId: 'req-1',
  traceId: 'trace-1',
  ip: '127.0.0.1',
}, 2, 50);
assert.match(query, /page=2/);
assert.match(query, /pageSize=50/);
assert.match(query, /action=auth.login/);
assert.match(query, /module=auth/);
assert.match(query, /actorUsername=admin/);
assert.match(query, /requestId=req-1/);
assert.doesNotMatch(query, /objectType/);
assert.match(query, /createdFrom=2026-06-30T04%3A00%3A00.000Z/);
assert.equal(toIsoWithTimezone(''), undefined);
assert.equal(toIsoWithTimezone('invalid'), undefined);

const exportQuery = buildAuditLogsExportQuery({ ...defaults, action: ' exported ', actorRole: 'audit' });
assert.match(exportQuery, /action=exported/);
assert.match(exportQuery, /actorRole=audit/);
assert.doesNotMatch(exportQuery, /page|pageSize/);

assert.equal(validateAuditLogsRange({ createdFrom: '2026-01-01T00:00' }), '开始时间和结束时间必须同时填写。');
assert.equal(validateAuditLogsRange({ createdFrom: '2026-02-01T00:00', createdTo: '2026-01-01T00:00' }), '开始时间不能晚于结束时间。');
assert.equal(validateAuditLogsRange({ createdFrom: '2026-01-01T00:00', createdTo: '2026-04-02T00:00' }), '查询时间范围不能超过 90 天。');
assert.equal(validateAuditLogsRange({ createdFrom: '2026-01-01T00:00', createdTo: '2026-03-31T00:00' }), null);

assert.equal(parseSafeAsciiFilename('attachment; filename="audit-logs-2026-07-01_2026-07-07.csv"'), 'audit-logs-2026-07-01_2026-07-07.csv');
assert.equal(parseSafeAsciiFilename('attachment'), null);
assert.equal(parseSafeAsciiFilename('attachment; filename="../audit.csv"'), null);
assert.equal(parseSafeAsciiFilename('attachment; filename="..\\audit.csv"'), null);
assert.equal(parseSafeAsciiFilename('attachment; filename="audit.csv\r\nX-Evil: yes"'), null);
assert.equal(parseSafeAsciiFilename('attachment; filename="审计.csv"'), null);
assert.equal(parseSafeAsciiFilename('attachment; filename="a:b.csv"'), null);
assert.equal(fallbackAuditLogsFilename(new Date(2026, 5, 21, 9, 8, 7)), 'audit-logs-20260621-090807.csv');

assert.equal(canExportAuditLogs({ userId: '1', roleCode: 'auditor', permissions: ['audit_log.view', 'salary.export'] }), false);
assert.equal(canExportAuditLogs({ userId: '1', roleCode: 'auditor', permissions: ['audit_log.view', 'audit_log.export'] }), true);
assert.equal(moduleLabel('sync_execution'), '同步执行');
assert.equal(moduleLabel('unknown'), 'unknown');
assert.deepEqual(auditResultTag('success'), { text: 'success', color: 'green' });
assert.deepEqual(auditResultTag('failure'), { text: 'failure', color: 'red' });

let revokedUrl = '';
let removedAnchor = false;
let clickedAnchor = false;
const fakeAnchor = {
  href: '',
  download: '',
  style: { display: '' },
  click: () => { clickedAnchor = true; },
  remove: () => { removedAnchor = true; },
};
triggerBlobDownload(new Blob(['csv']), 'audit.csv', {
  document: { createElement: () => fakeAnchor, body: { appendChild: () => fakeAnchor } } as never,
  url: { createObjectURL: () => 'blob:test', revokeObjectURL: (value) => { revokedUrl = value; } },
  schedule: (callback) => callback(),
});
assert.equal(clickedAnchor, true);
assert.equal(removedAnchor, true);
assert.equal(revokedUrl, 'blob:test');

const listGuard = createLatestRequestGuard();
const oldList = listGuard.begin();
const newList = listGuard.begin();
assert.equal(listGuard.isCurrent(oldList), false);
assert.equal(listGuard.isCurrent(newList), true);
const detailGuard = createLatestRequestGuard();
const oldDetail = detailGuard.begin();
detailGuard.invalidate();
assert.equal(detailGuard.isCurrent(oldDetail), false);

const mounted = { current: false };
const cleanup = setupAuditLogRequestLifecycle(mounted, listGuard, detailGuard);
assert.equal(mounted.current, true);
cleanup();
assert.equal(mounted.current, false);

const safeJson = safeAuditJsonText({
  visible: 'ok',
  password: 'pw',
  clientSecret: 'secret',
  nested: { token: 'token', text: 'Bearer abc.def token=raw apiKey=raw' },
});
assert.match(safeJson, /visible/);
assert.doesNotMatch(safeJson, /pw|secret|abc\.def|token=raw|apiKey=raw|clientSecret/);

console.log('audit-log-utils tests passed');
