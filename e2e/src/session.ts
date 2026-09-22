// A plain fetch-based session with a hand-rolled cookie jar, one per user —
// the same pattern server/src/seed.ts uses. Not Playwright's `request`
// module: under bun 1.3.14, playwright-core@1.63's response handling calls
// `new URL(responseUrl)` with a RELATIVE url whenever a response carries
// Set-Cookie (reproduced standalone — `ctx.post()`/`ctx.fetch()` both hang
// until the 30s timeout the instant Better Auth's sign-in sets a cookie).
// The same code runs clean under plain node. This is a bun+playwright-core
// incompatibility, not anything in this app — see RESULTS.md. Browser
// automation (chromium.launch/newContext/page) is unaffected and is used
// as directed for the sheet pages.
export const SERVER = 'http://localhost:8800';
export const WEB = 'http://localhost:5180';

export type ApiResult<T = unknown> = { status: number; json: T };

export class Session {
  cookie = '';
  userId = '';
  email = '';

  private async raw<T>(
    method: string,
    path: string,
    init: { form?: FormData; json?: unknown } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { Origin: WEB };
    if (this.cookie) headers.cookie = this.cookie;
    let body: FormData | string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      body = init.form;
    }
    const res = await fetch(`${SERVER}${path}`, { method, headers, body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json: json as T };
  }

  get<T>(path: string) {
    return this.raw<T>('GET', path);
  }
  post<T>(path: string, json?: unknown) {
    return this.raw<T>('POST', path, { json });
  }
  patch<T>(path: string, json?: unknown) {
    return this.raw<T>('PATCH', path, { json });
  }
  del<T>(path: string) {
    return this.raw<T>('DELETE', path);
  }
  postForm<T>(path: string, form: FormData) {
    return this.raw<T>('POST', path, { form });
  }

  /** Raw response, for endpoints that answer binary (tiles, originals). */
  async getRaw(path: string): Promise<Response> {
    const headers: Record<string, string> = { Origin: WEB };
    if (this.cookie) headers.cookie = this.cookie;
    return fetch(`${SERVER}${path}`, { headers });
  }
}

export async function signIn(
  email: string,
  password: string,
): Promise<Session> {
  const s = new Session();
  const res = await s.post<{ user?: { id: string } }>(
    '/api/auth/sign-in/email',
    { email, password },
  );
  if (res.status !== 200 || !res.json.user) {
    throw new Error(
      `sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.json)}`,
    );
  }
  s.userId = res.json.user.id;
  s.email = email;
  return s;
}
