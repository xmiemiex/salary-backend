import { Alert, Button, Form, Input, Layout, Typography } from 'antd';

type LoginPageProps = {
  loading: boolean;
  error: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
};

export function LoginPage({ loading, error, onLogin }: LoginPageProps) {
  return (
    <Layout className="login-shell">
      <div className="login-panel">
        <Typography.Title level={3} className="login-title">工资结算后台</Typography.Title>
        <Typography.Text type="secondary">请使用管理员账号和密码登录。</Typography.Text>
        <Form layout="vertical" className="login-form" onFinish={async ({ username, password }: { username: string; password: string }) => onLogin(username.trim(), password)}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }, { whitespace: true, message: '用户名不能为空' }]}>
            <Input autoFocus autoComplete="username" disabled={loading} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" disabled={loading} />
          </Form.Item>
          {error ? <Alert type="error" message={error} showIcon className="login-alert" /> : null}
          <Button type="primary" htmlType="submit" loading={loading} block>登录</Button>
        </Form>
      </div>
    </Layout>
  );
}
