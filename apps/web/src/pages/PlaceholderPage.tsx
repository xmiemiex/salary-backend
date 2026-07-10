import { Result, Typography } from 'antd';
import type { AdminMenuItem } from '../navigation/menu';

type PlaceholderPageProps = {
  item: AdminMenuItem;
};

export function PlaceholderPage({ item }: PlaceholderPageProps) {
  return (
    <section className="page-section">
      <Typography.Title level={3}>{item.title}</Typography.Title>
      <Typography.Paragraph type="secondary">
        当前为路由占位页。后续业务页面可在此接入列表、筛选、导入、审核或结算操作。
      </Typography.Paragraph>
      <div className="placeholder-box">
        <div>
          <span className="placeholder-label">路由</span>
          <Typography.Text code>{item.path}</Typography.Text>
        </div>
        <div>
          <span className="placeholder-label">入口权限</span>
          <Typography.Text>{item.permissions?.join(' / ') ?? '登录用户可见'}</Typography.Text>
        </div>
      </div>
    </section>
  );
}

export function NoPermissionPage() {
  return (
    <Result
      status="403"
      title="无权限"
      subTitle="当前账号没有访问该页面入口所需的权限。"
      className="plain-result"
    />
  );
}
