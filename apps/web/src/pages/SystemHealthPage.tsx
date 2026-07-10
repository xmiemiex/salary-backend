import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import {
  containsSensitiveSystemHealthField,
  sectionRows,
  sortChecks,
  statusLabel,
  type SystemHealthResponse,
} from './system-health-utils';

const SECTIONS: Array<{ key: keyof SystemHealthResponse; title: string }> = [
  { key: 'environment', title: '环境与版本' },
  { key: 'database', title: '数据库与迁移' },
  { key: 'syncPlanning', title: '同步规划状态' },
  { key: 'autoExecution', title: '自动执行状态' },
  { key: 'credentials', title: 'provider 凭证完整性' },
  { key: 'settlements', title: '锁账与结算状态' },
  { key: 'dataProtection', title: '数据保全' },
  { key: 'audit', title: '权限与审计健康' },
  { key: 'e2e', title: 'E2E / 自检状态' },
];

export function SystemHealthPage() {
  const [data, setData] = useState<SystemHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await apiClient.request<SystemHealthResponse>('/system-health');
      if (containsSensitiveSystemHealthField(next)) {
        setData(null);
        setError('系统健康 API 返回包含敏感字段，页面已阻止渲染。');
        return;
      }
      setData(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '系统健康加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  try {
    const sortedChecks = sortChecks(Array.isArray(data?.checks) ? data.checks : []);
    return (
    <div className="system-health-page" data-testid="system-health-page">
      <div className="page-heading">
        <div>
          <h2>系统健康 / 运维中心</h2>
          <p className="muted-text">只读查看配置、运行健康、风险项和最近关键事件。</p>
        </div>
        <button className="plain-button" type="button" disabled={loading} onClick={load} data-testid="system-health-refresh">
          {loading ? '刷新中' : '刷新'}
        </button>
      </div>

      {error ? <div className="health-alert">{error}</div> : null}

      <section className="health-panel" data-testid="system-health-summary">
        <h3>总体健康摘要</h3>
        <div className="health-summary-row">
          <span className={`health-status health-status-${data?.status ?? 'warning'}`}>{statusLabel(data?.status ?? 'warning')}</span>
          <span className="muted-text">生成时间：{data?.generatedAt ?? '-'}</span>
        </div>
      </section>

      {SECTIONS.map((section) => (
        <section className="health-panel" key={section.key} data-testid={`system-health-section-${section.key}`}>
          <h3>{section.title}</h3>
          {data ? (
            <div className="health-kv-grid">
              {sectionRows(data[section.key] as Record<string, unknown>).map((row, index) => (
                <div className="health-kv-row" key={`${section.key}-${row.key}-${index}`}>
                  <span className="health-kv-key">{row.key}</span>
                  <span className="health-kv-value">{row.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-text">暂无数据</p>
          )}
        </section>
      ))}

      <section className="health-panel" data-testid="system-health-incidents">
        <h3>最近异常事件</h3>
        {data?.recentIncidents.length ? (
          <div className="health-list">
            {data.recentIncidents.map((incident, index) => (
              <div className="health-list-row" key={`incident-${index}-${incident.type ?? ''}-${incident.occurredAt ?? ''}`}>
                <span className={`health-status health-status-${incident.severity === 'critical' ? 'critical' : 'warning'}`}>{String(incident.severity ?? '-')}</span>
                <span>{String(incident.type ?? '-')}</span>
                <span>{String(incident.title ?? '-')}</span>
                <span>{String(incident.summary ?? '-')}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted-text">暂无异常事件</p>
        )}
      </section>

      <section className="health-panel" data-testid="system-health-checks">
        <h3>检查项</h3>
        <div className="health-list">
          {sortedChecks.map((item, index) => (
            <div className="health-list-row" key={`check-${index}-${item.code ?? ''}`}>
              <span className={`health-status health-status-${item.status}`}>{statusLabel(item.status)}</span>
              <span>{item.code}</span>
              <span>{item.title}</span>
              <span>{item.message}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
    );
  } catch (renderError) {
    return (
      <div className="system-health-page" data-testid="system-health-page">
        <section className="health-panel" data-testid="system-health-render-error">
          <h2>系统健康 / 运维中心</h2>
          <p className="health-alert">{renderError instanceof Error ? renderError.message : '系统健康页面渲染失败。'}</p>
        </section>
      </div>
    );
  }
}
