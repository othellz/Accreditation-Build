// Fetch wrapper: JSON in/out, timeouts, and a connection-problem signal for the gate.
const listeners = new Set();
let offline = false;

export function onConnectionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setOffline(v) {
  if (offline === v) return;
  offline = v;
  listeners.forEach((fn) => fn(v));
}

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method = 'GET', body, form, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = {};
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, signal: ctrl.signal, credentials: 'same-origin' });
  } catch {
    setOffline(true);
    throw new ApiError(0, { error: 'Weak or no connection. Nothing was lost — try again.' });
  } finally {
    clearTimeout(timer);
  }
  setOffline(false);
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('auth-expired'));
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p, body) => api(p, { method: 'DELETE', body });

export function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
