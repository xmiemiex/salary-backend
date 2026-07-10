import type { Actor, Session } from '../types/session';

const TOKEN_KEY = 'salary_admin_session_token';
const ACTOR_KEY = 'salary_admin_actor';

export function getStoredToken(): string | null {
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string) {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function saveActor(actor: Actor) {
  window.sessionStorage.setItem(ACTOR_KEY, JSON.stringify(actor));
}

export function saveSession(session: Session) {
  saveToken(session.token);
  saveActor(session.actor);
}

export function getStoredActor(): Actor | null {
  const value = window.sessionStorage.getItem(ACTOR_KEY);
  if (!value) return null;

  try {
    return JSON.parse(value) as Actor;
  } catch {
    window.sessionStorage.removeItem(ACTOR_KEY);
    return null;
  }
}

export function clearSession() {
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.sessionStorage.removeItem(ACTOR_KEY);
}
