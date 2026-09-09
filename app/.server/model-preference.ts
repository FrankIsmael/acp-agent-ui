import { createCookie } from "react-router";

// Solo una preferencia; las conversaciones y credenciales nunca van a la cookie.
export const modelPreference = createCookie("acp-model", {
  path: "/", httpOnly: true, sameSite: "lax", maxAge: 365 * 24 * 60 * 60,
});
export async function readModelPreference(request: Request): Promise<string | null> {
  try {
    const value = await modelPreference.parse(request.headers.get("cookie"));
    return typeof value === "string" && value.length <= 256 ? value : null;
  } catch { return null; }
}
