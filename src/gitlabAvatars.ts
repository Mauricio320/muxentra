export interface GitlabAuthor {
  email: string;
  name: string;
}

interface GitlabUser {
  name?: string;
  public_email?: string;
  avatar_url?: string;
}

const API = 'https://gitlab.com/api/v4';
const MAX_AUTHORS = 24;

export function isGitlabRemote(remote: string): boolean {
  if (/^git@gitlab\.com:/i.test(remote)) return true;
  try {
    const url = new URL(remote);
    return url.hostname.toLowerCase() === 'gitlab.com' && ['https:', 'ssh:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function uploadedAvatar(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'gitlab.com' && url.pathname.startsWith('/uploads/')) return url.href;
  } catch {
    // La API puede devolver una URL vacía o inválida.
  }
  return undefined;
}

function nameKey(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export class GitlabAvatarLookup {
  private readonly cache = new Map<string, Promise<string | undefined>>();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async find(authors: readonly GitlabAuthor[]): Promise<Record<string, string>> {
    const distinct = new Map<string, string>();
    for (const author of authors) {
      const email = author.email.trim().toLowerCase();
      const name = author.name.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      if (!distinct.has(email) && distinct.size >= MAX_AUTHORS) continue;
      if (name.length > (distinct.get(email)?.length ?? 0)) distinct.set(email, name);
    }
    const entries = [...distinct];
    const found: Record<string, string> = {};
    for (let index = 0; index < entries.length; index += 3) {
      await Promise.all(entries.slice(index, index + 3).map(async ([email, name]) => {
        let lookup = this.cache.get(email);
        if (!lookup) {
          lookup = this.resolve(email, name).then(url => {
            if (!url) this.cache.delete(email);
            return url;
          });
          this.cache.set(email, lookup);
        }
        const url = await lookup;
        if (url) found[email] = url;
      }));
    }
    return found;
  }

  private async json(url: string): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolve(email: string, name: string): Promise<string | undefined> {
    const direct = await this.json(`${API}/avatar?email=${encodeURIComponent(email)}&size=64`) as { avatar_url?: unknown } | undefined;
    const avatar = uploadedAvatar(direct?.avatar_url);
    if (avatar) return avatar;

    const byEmail = await this.json(`${API}/users?search=${encodeURIComponent(email)}&per_page=20`);
    if (Array.isArray(byEmail)) {
      const users = byEmail as GitlabUser[];
      const exact = users.filter(user => user.public_email?.trim().toLowerCase() === email);
      if (exact.length === 1) {
        const match = uploadedAvatar(exact[0].avatar_url);
        if (match) return match;
      }
      if (users.length === 1) {
        const only = uploadedAvatar(users[0].avatar_url);
        if (only) return only;
      }
    }

    if (nameKey(name).split(' ').length < 2) return undefined;
    const byName = await this.json(`${API}/users?search=${encodeURIComponent(name)}&per_page=20`);
    if (!Array.isArray(byName)) return undefined;
    const matches = (byName as GitlabUser[]).filter(user => user.name && nameKey(user.name) === nameKey(name));
    return matches.length === 1 ? uploadedAvatar(matches[0].avatar_url) : undefined;
  }
}
