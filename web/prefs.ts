// Small page settings that live in the URL hash and in localStorage. Pure functions so they can be tested.

/** Reads the text switch from a hash like "#go=3&text=off". Returns null when the hash does not say. */
export function textFlagFromHash(hash: string): boolean | null {
  const m = /(?:^|[#&])text=([a-z0-9]*)/i.exec(hash);
  if (!m) return null;
  const v = m[1]!.toLowerCase();
  if (v === 'off' || v === '0' || v === 'no') return false;
  if (v === 'on' || v === '1' || v === 'yes') return true;
  return null;
}

/** Same idea for the saved value in localStorage ("0" or "1"). */
export function textFlagFromStore(v: string | null): boolean | null {
  return v === '0' ? false : v === '1' ? true : null;
}

/** Sets or removes one key in a hash, keeping the other keys (go=, theme=) as they are. */
export function withHashParam(hash: string, key: string, value: string | null): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith(key + '='));
  if (value !== null) parts.push(`${key}=${value}`);
  return parts.length ? '#' + parts.join('&') : '';
}

/** First-visit TEXT tip: show only when the tip has never been dismissed and there is no saved text preference yet. */
export function shouldShowTextTip(tipSeen: string | null, textStore: string | null): boolean {
  if (tipSeen) return false;
  if (textStore !== null) return false;
  return true;
}
