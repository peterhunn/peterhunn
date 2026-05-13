export interface Auth {
  apiKey: string;
  tenantId: string;
  baseUrl: string;
}

export function getAuth(): Auth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("x490_auth");
    return raw ? (JSON.parse(raw) as Auth) : null;
  } catch { return null; }
}

export function setAuth(auth: Auth): void {
  localStorage.setItem("x490_auth", JSON.stringify(auth));
}

export function clearAuth(): void {
  localStorage.removeItem("x490_auth");
}
