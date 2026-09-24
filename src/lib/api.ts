// Chiamate alle API del bot dalla dashboard, con il token amministratore (F1).
// Il token è salvato nel localStorage del browser: è una dashboard a utente singolo; chi ha
// accesso al browser ha accesso al bot. Il token si può cancellare con il pulsante "Esci".
const TOKEN_KEY = 'arbiter.adminToken';

export type AuthProblem = 'UNAUTHORIZED' | 'ADMIN_DISABLED';

export class AuthRequiredError extends Error {
  constructor(message: string, readonly code: AuthProblem) {
    super(message);
  }
}

export function getAdminToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage non disponibile (es. navigazione privata): il token resta solo in memoria
  }
}

/** fetch con `Authorization: Bearer <token>`; lancia AuthRequiredError su 401/503 di autenticazione. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getAdminToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 || res.status === 503) {
    let body: { error?: string; code?: string } | null = null;
    try {
      body = await res.clone().json();
    } catch {
      body = null;
    }
    if (body?.code === 'UNAUTHORIZED' || body?.code === 'ADMIN_DISABLED') {
      throw new AuthRequiredError(body.error ?? 'Accesso richiesto', body.code);
    }
  }
  return res;
}
