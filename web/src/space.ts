const KEY = "space-id";
// Durable "last space I was actually in". Unlike KEY (cleared when landing on the
// root route), this survives login redirects and reloads so we can restore the
// user back to the space holding their work/connections — instead of snapping
// them to the first-created space, which may be empty.
const LAST = "last-space-id";
const SAFE = /^[A-Za-z0-9_-]+$/;

function readKey(k: string): string {
  try {
    const v = localStorage.getItem(k);
    if (v && SAFE.test(v)) return v;
  } catch {
    void 0;
  }
  return "";
}

let current = readKey(KEY);

export function getSpace(): string {
  return current;
}

// The last non-empty space the user was in (persists across login/reload).
export function getLastSpace(): string {
  return readKey(LAST);
}

export function setSpace(id: string): void {
  if (id && !SAFE.test(id)) return;
  current = id;
  try {
    if (id) {
      localStorage.setItem(KEY, id);
      localStorage.setItem(LAST, id); // remember it even after KEY is cleared
    } else {
      localStorage.removeItem(KEY); // keep LAST so we can restore on next login
    }
  } catch {
    void 0;
  }
}

export function spaceHeaders(): Record<string, string> {
  return current ? { "x-space-id": current } : {};
}
