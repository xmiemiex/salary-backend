import { Spin, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { apiClient, ApiError } from './lib/api-client';
import { clearSession, getStoredActor, getStoredToken, saveSession } from './lib/auth-storage';
import { logoutAndClear } from './lib/auth-flow';
import { AdminLayout, getVisibleMenu } from './layout/AdminLayout';
import { LoginPage } from './pages/LoginPage';
import type { Actor } from './types/session';
import './styles.css';

function normalizePath(path: string): string {
  if (!path || path === '/' || path === '/login') return '/dashboard';
  return path;
}

export function App() {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [actor, setActor] = useState<Actor | null>(() => getStoredActor());
  const [checking, setChecking] = useState(Boolean(getStoredToken()));
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(() => normalizePath(window.location.pathname));
  const [messageApi, contextHolder] = message.useMessage();
  const authenticated = Boolean(token && actor);

  const clearLocalSession = useCallback(() => {
    clearSession();
    setToken(null);
    setActor(null);
    setLoginError(null);
    window.history.replaceState(null, '', '/login');
    setCurrentPath('/login');
  }, []);

  const logout = useCallback(async () => {
    await logoutAndClear(() => apiClient.logout(), clearLocalSession).catch(() => undefined);
  }, [clearLocalSession]);

  useEffect(() => {
    apiClient.configure({
      getToken: () => getStoredToken(),
      onUnauthorized: () => {
        clearLocalSession();
        messageApi.error('认证已失效，请重新登录。');
      },
      onPermissionDenied: (error) => {
        messageApi.warning(error.message || '无权限执行该操作。');
      },
    });
  }, [clearLocalSession, messageApi]);

  useEffect(() => {
    const onPopState = () => setCurrentPath(normalizePath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (checking) return;

    if (!authenticated) {
      if (window.location.pathname !== '/login') {
        window.history.replaceState(null, '', '/login');
        setCurrentPath('/login');
      }
      return;
    }

    if (actor && (window.location.pathname === '/login' || window.location.pathname === '/')) {
      const firstPath = getVisibleMenu(actor)[0]?.path ?? '/dashboard';
      window.history.replaceState(null, '', firstPath);
      setCurrentPath(firstPath);
    }
  }, [actor, authenticated, checking]);

  useEffect(() => {
    const restore = async () => {
      const storedToken = getStoredToken();
      if (!storedToken) {
        setChecking(false);
        return;
      }

      try {
        const nextActor = await apiClient.getMe(storedToken);
        saveSession({ token: storedToken, actor: nextActor });
        setToken(storedToken);
        setActor(nextActor);
      } catch {
        clearSession();
        setToken(null);
        setActor(null);
      } finally {
        setChecking(false);
      }
    };

    void restore();
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setCurrentPath(path);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const session = await apiClient.login(username, password);
      saveSession(session);
      setToken(session.token);
      setActor(session.actor);
      const firstPath = getVisibleMenu(session.actor)[0]?.path ?? '/dashboard';
      window.history.replaceState(null, '', firstPath);
      setCurrentPath(firstPath);
    } catch (error) {
      clearSession();
      setToken(null);
      setActor(null);
      const fallback = '登录失败，请检查用户名和密码。';
      const nextMessage = error instanceof ApiError ? error.message : fallback;
      setLoginError(nextMessage || fallback);
    } finally {
      setLoginLoading(false);
    }
  }, []);

  if (checking) {
    return (
      <div className="loading-screen">
        {contextHolder}
        <Spin size="large" />
      </div>
    );
  }

  if (!authenticated || !actor) {
    return (
      <>
        {contextHolder}
        <LoginPage loading={loginLoading} error={loginError} onLogin={login} />
      </>
    );
  }

  return (
    <>
      {contextHolder}
      <AdminLayout actor={actor} currentPath={currentPath} onNavigate={navigate} onLogout={logout} onCurrentSessionInvalidated={clearLocalSession} />
    </>
  );
}
