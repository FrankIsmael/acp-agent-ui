import { createCookie } from 'react-router';

export const modelPreference = createCookie('acp-model', {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 365 * 24 * 60 * 60,
});
export async function readModelPreference(
  request: Request,
): Promise<string | null> {
  try {
    const value = await modelPreference.parse(request.headers.get('cookie'));
    return typeof value === 'string' && value.length <= 256 ? value : null;
  } catch {
    return null;
  }
}
