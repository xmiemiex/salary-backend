import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getVisibleMenu } from '../src/layout/AdminLayout';
import { compactJson, containsSensitiveAlertField, severityColor, statusColor } from '../src/pages/alerts-utils';

assert.equal(severityColor('critical'), 'red');
assert.equal(severityColor('warning'), 'gold');
assert.equal(statusColor('active'), 'red');
assert.equal(statusColor('resolved'), 'green');
assert.equal(compactJson({ safe: true }), '{\n  "safe": true\n}');
assert.equal(containsSensitiveAlertField({ safe: 'value' }), false);
assert.equal(containsSensitiveAlertField({ token: 'abc' }), true);
assert.equal(containsSensitiveAlertField({ leaseOwner: 'worker' }), true);

const highMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['alerts.read', 'notifications.read'] });
assert.equal(highMenu.some((item) => item.path === '/alerts'), true);
const lowMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['salary.view_self'] });
assert.equal(lowMenu.some((item) => item.path === '/alerts'), false);

const alertsPage = readFileSync(new URL('../src/pages/AlertsPage.tsx', import.meta.url), 'utf8');
assert.match(alertsPage, /\/alerts\/scan/);
assert.match(alertsPage, /告警中心/);
assert.match(alertsPage, /详情/);
assert.match(alertsPage, /确认/);
assert.match(alertsPage, /静默/);
assert.match(alertsPage, /containsSensitiveAlertField/);
assert.doesNotMatch(alertsPage, /dangerouslySetInnerHTML|DATABASE_URL|leaseOwner|tokenHash|passwordHash|encryptedPayload/);

const bell = readFileSync(new URL('../src/layout/NotificationBell.tsx', import.meta.url), 'utf8');
assert.match(bell, /\/notifications\/unread-count/);
assert.match(bell, /\/notifications\/read-all/);
assert.match(bell, /站内通知/);
assert.doesNotMatch(bell, /dangerouslySetInnerHTML|DATABASE_URL|leaseOwner|tokenHash|passwordHash|encryptedPayload/);

console.log('alerts page tests passed');
