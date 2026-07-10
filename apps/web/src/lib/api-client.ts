import type { ErrorCode } from '@salary/shared';
import type { Actor } from '../types/session';
import type { Session } from '../types/session';

type BackendErrorBody = {
  success: false;
  error: {
    code: ErrorCode | 'INTERNAL_SERVER_ERROR';
    message: string;
    details?: unknown;
  };
};

type RequestOptions = RequestInit & {
  token?: string | null;
  handleAuthErrors?: boolean;
};

export type DownloadResponse = {
  blob: Blob;
  contentType: string | null;
  contentDisposition: string | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiClientHandlers = {
  getToken: () => string | null;
  onUnauthorized: () => void;
  onPermissionDenied: (error: ApiError) => void;
};

export class ApiClient {
  private readonly baseURL: string;
  private handlers: ApiClientHandlers | null = null;

  constructor(baseURL = import.meta.env?.VITE_API_BASE_URL ?? 'http://localhost:3000') {
    this.baseURL = baseURL.replace(/\/+$/, '');
  }

  configure(handlers: ApiClientHandlers) {
    this.handlers = handlers;
  }

  async getMe(token?: string | null, handleAuthErrors = true): Promise<Actor> {
    const response = await this.request<{ actor: Actor }>('/me', {
      method: 'GET',
      token,
      handleAuthErrors,
    });
    return response.actor;
  }

  async login(username: string, password: string): Promise<Session> {
    return this.request<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      token: null,
      handleAuthErrors: false,
    });
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST', handleAuthErrors: false });
  }

  async changePassword(input: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<{ success: true }> {
    return this.request('/auth/change-password', { method: 'POST', body: JSON.stringify(input), handleAuthErrors: false });
  }

  async revokeSession(id: string): Promise<{ success: true; currentSessionRevoked: boolean }> {
    return this.request(`/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  }

  async logoutAll(): Promise<{ success: true }> {
    return this.request('/auth/logout-all', { method: 'POST', handleAuthErrors: false });
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = options.token ?? this.handlers?.getToken() ?? null;
    const headers = new Headers(options.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${this.baseURL}${path}`, {
      ...options,
      headers,
    });
    const payload = await this.readPayload(response);

    if (!response.ok || this.isBackendError(payload)) {
      const error = this.toApiError(response, payload);
      this.handleError(error, options.handleAuthErrors ?? true);
      throw error;
    }

    return payload as T;
  }

  async download(path: string, options: RequestOptions = {}): Promise<DownloadResponse> {
    const token = options.token ?? this.handlers?.getToken() ?? null;
    const headers = new Headers(options.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(`${this.baseURL}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const payload = await this.readPayload(response);
      const error = this.toApiError(response, payload);
      this.handleError(error, options.handleAuthErrors ?? true);
      throw error;
    }

    return {
      blob: await response.blob(),
      contentType: response.headers.get('Content-Type'),
      contentDisposition: response.headers.get('Content-Disposition'),
    };
  }

  private async readPayload(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private isBackendError(payload: unknown): payload is BackendErrorBody {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'success' in payload &&
      (payload as { success?: unknown }).success === false
    );
  }

  private toApiError(response: Response, payload: unknown): ApiError {
    if (this.isBackendError(payload)) {
      return new ApiError(response.status, payload.error.code, payload.error.message, payload.error.details);
    }

    return new ApiError(response.status, `HTTP_${response.status}`, response.statusText || 'Request failed.');
  }

  private handleError(error: ApiError, enabled: boolean) {
    if (!enabled || !this.handlers) return;
    if (error.status === 401 || error.code === 'UNAUTHORIZED') {
      this.handlers.onUnauthorized();
      return;
    }
    if (error.status === 403 || error.code === 'PERMISSION_DENIED') {
      this.handlers.onPermissionDenied(error);
    }
  }
}

export const apiClient = new ApiClient();
