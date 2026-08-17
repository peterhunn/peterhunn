import { cookies } from "next/headers";

const COOKIE = "atelier_token";

export const setSessionToken = async (token: string): Promise<void> => {
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
};

export const getSessionToken = async (): Promise<string | null> => {
  const jar = await cookies();
  return jar.get(COOKIE)?.value ?? null;
};

export const clearSessionToken = async (): Promise<void> => {
  const jar = await cookies();
  jar.delete(COOKIE);
};
