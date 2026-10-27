/**
 * OSINT API client
 * All endpoints are prefixed with /osint and proxied to the rag_pipeline backend
 */

import { OSINT_BASE_URL } from '../../lib/api';

function osintUrl(endpoint) {
  return `${OSINT_BASE_URL}${endpoint}`;
}

// The OSINT Flask app is reached directly by the browser and verifies the SAGA
// JWT itself to derive a TRUSTED tenant_id (no spoofable headers). Send the token
// on every call: as a Bearer header for fetch, and as a ?token= query param for
// EventSource/SSE (which cannot set custom headers).
function authToken() {
  return localStorage.getItem('token') || '';
}

function authHeaders() {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Build an SSE URL with the auth token appended as a query param.
function streamUrl(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  return osintUrl(`${endpoint}${sep}token=${encodeURIComponent(authToken())}`);
}

function siteFromUrl(url) {
  if (!url) return '';
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h || url;
  } catch {
    return url;
  }
}

function normalizeEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  if (payload.type !== 'result') {
    return payload;
  }

  const raw = payload.data && typeof payload.data === 'object'
    ? { ...payload, ...payload.data }
    : { ...payload };

  const normalized = { ...raw };

  if (!normalized.name && normalized.site_name) {
    normalized.name = normalized.site_name;
  }

  if (!normalized.site && normalized.platform) {
    normalized.site = normalized.platform;
  }

  if (!normalized.site && !normalized.name && normalized.url) {
    const site = siteFromUrl(normalized.url);
    normalized.site = site;
    normalized.name = site;
  }

  if (normalized.exists !== undefined && normalized.found === undefined) {
    normalized.found = Boolean(normalized.exists);
  }

  if (normalized.found === undefined) {
    normalized.found = true;
  }

  return normalized;
}

/**
 * Create an EventSource for SSE streams with auth headers
 */
export function createEventSource(url) {
  return new EventSource(url);
}

/**
 * Generic fetch helper for JSON APIs
 */
async function osintFetch(endpoint, options = {}) {
  const url = osintUrl(endpoint);
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

// ─── Email Tools ───────────────────────────────────────────────────────────

export function streamHolehe(email, onEvent) {
  const url = streamUrl(`/api/stream/holehe?email=${encodeURIComponent(email)}`);
  const es = createEventSource(url);
  es.onmessage = (e) => {
    try {
      const data = normalizeEventPayload(JSON.parse(e.data));
      onEvent(data);
      if (data.type === 'complete' || data.type === 'error') {
        es.close();
      }
    } catch {
      onEvent({ type: 'raw', data: e.data });
    }
  };
  es.onerror = () => {
    onEvent({ type: 'error', message: 'Connection lost' });
    es.close();
  };
  return () => es.close();
}

export function fetchDisposableCheck(email) {
  return osintFetch(`/api/results/disposable?email=${encodeURIComponent(email)}`).then((data) => ({
    ...data,
    disposable: data.disposable ?? data.is_disposable,
  }));
}

export function fetchEmailPivots(email) {
  return osintFetch(`/api/results/email-pivots?email=${encodeURIComponent(email)}`);
}

export function fetchPhoneIntelligence(phone) {
  return osintFetch(`/api/results/phone?phone=${encodeURIComponent(phone)}`);
}

// ─── Username Tools ────────────────────────────────────────────────────────

export function streamSherlock(username, onEvent) {
  const url = streamUrl(`/api/stream/sherlock?username=${encodeURIComponent(username)}`);
  const es = createEventSource(url);
  es.onmessage = (e) => {
    try {
      const data = normalizeEventPayload(JSON.parse(e.data));
      onEvent(data);
      if (data.type === 'complete' || data.type === 'error') {
        es.close();
      }
    } catch {
      onEvent({ type: 'raw', data: e.data });
    }
  };
  es.onerror = () => {
    onEvent({ type: 'error', message: 'Connection lost' });
    es.close();
  };
  return () => es.close();
}

export function streamMaigret(username, onEvent) {
  const url = streamUrl(`/api/stream/maigret?username=${encodeURIComponent(username)}`);
  const es = createEventSource(url);
  es.onmessage = (e) => {
    try {
      const data = normalizeEventPayload(JSON.parse(e.data));
      onEvent(data);
      if (data.type === 'complete' || data.type === 'error') {
        es.close();
      }
    } catch {
      onEvent({ type: 'raw', data: e.data });
    }
  };
  es.onerror = () => {
    onEvent({ type: 'error', message: 'Connection lost' });
    es.close();
  };
  return () => es.close();
}

export function streamUsernameFootprint(username, onEvent) {
  const url = streamUrl(`/api/stream/username-footprint?username=${encodeURIComponent(username)}`);
  const es = createEventSource(url);
  es.onmessage = (e) => {
    try {
      const data = normalizeEventPayload(JSON.parse(e.data));
      onEvent(data);
      if (data.type === 'complete' || data.type === 'error') {
        es.close();
      }
    } catch {
      onEvent({ type: 'raw', data: e.data });
    }
  };
  es.onerror = () => {
    onEvent({ type: 'error', message: 'Connection lost' });
    es.close();
  };
  return () => es.close();
}

// ─── User Scanner ────────────────────────────────────────────────────────

export function streamUserScanner(scanType, query, onEvent) {
  const url = streamUrl(`/api/stream/scan?type=${encodeURIComponent(scanType)}&query=${encodeURIComponent(query)}`);
  const es = createEventSource(url);
  es.onmessage = (e) => {
    try {
      const data = normalizeEventPayload(JSON.parse(e.data));
      onEvent(data);
      if (data.type === 'complete' || data.type === 'error') {
        es.close();
      }
    } catch {
      onEvent({ type: 'raw', data: e.data });
    }
  };
  es.onerror = () => {
    onEvent({ type: 'error', message: 'Connection lost' });
    es.close();
  };
  return () => es.close();
}

// ─── Image Intelligence ──────────────────────────────────────────────────

export function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);
  return fetch(osintUrl('/image-intel/upload'), {
    method: 'POST',
    credentials: 'include',
    headers: { ...authHeaders() },
    body: formData,
  }).then((r) => r.json());
}

export function analyzeImage() {
  return fetch(osintUrl('/image-intel/analyze'), {
    method: 'POST',
    credentials: 'include',
    headers: { ...authHeaders() },
  }).then((r) => r.json());
}

export function checkImageStatus() {
  return fetch(osintUrl('/image-intel/status'), {
    credentials: 'include',
    headers: { ...authHeaders() },
  }).then((r) => r.json());
}

// ─── Infrastructure Intelligence ─────────────────────────────────────────

export function runInfrastructureIntel(query) {
  return osintFetch('/api/infra-intel', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

// ─── AI Assistant ────────────────────────────────────────────────────────

export function askAI(query) {
  return osintFetch('/api/ask-ai', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

// ─── Export ──────────────────────────────────────────────────────────────

export function exportDashboardPDF(payload) {
  return fetch(osintUrl('/api/export/dashboard-pdf'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  }).then((r) => {
    if (!r.ok) return r.json().then((j) => { throw new Error(j.error || 'Export failed'); });
    return r.blob();
  });
}
