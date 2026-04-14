import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3001'];

app.use(cors({
  origin: isProduction ? true : ALLOWED_ORIGINS,
  methods: ['GET', 'HEAD', 'OPTIONS'],
}));

app.use(express.json());
app.set('trust proxy', 1);

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 60;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return next();
  }
  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap) {
    if (now - record.start > RATE_LIMIT_WINDOW) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW);

const FETCH_TIMEOUT = 30_000;

const US_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
};

function getAgent(url) {
  return url.startsWith('https') ? httpsAgent : httpAgent;
}

async function fetchWithFallback(targetUrl, options) {
  try {
    return await fetch(targetUrl, { ...options, agent: getAgent(targetUrl) });
  } catch (err) {
    if (targetUrl.startsWith('https://')) {
      const httpUrl = targetUrl.replace('https://', 'http://');
      console.log(`HTTPS failed for ${targetUrl}, trying HTTP...`);
      return fetch(httpUrl, { ...options, agent: httpAgent });
    }
    if (targetUrl.startsWith('http://')) {
      const httpsUrl = targetUrl.replace('http://', 'https://');
      console.log(`HTTP failed for ${targetUrl}, trying HTTPS...`);
      return fetch(httpsUrl, { ...options, agent: httpsAgent });
    }
    throw err;
  }
}

function normalizeUrl(raw) {
  let target = raw.trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
    return parsed.href;
  } catch {
    return null;
  }
}

const HEADERS_TO_STRIP = [
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'x-content-type-options',
  'strict-transport-security', 'permissions-policy',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy',
  'cross-origin-resource-policy',
];

function getProxyOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  return `${proto}://${host}`;
}

function rewriteHtml(html, baseUrl, proxyOrigin) {
  const proxyRender = `${proxyOrigin}/api/render?url=`;
  const proxyAsset = `${proxyOrigin}/api/asset?url=`;

  let baseOrigin;
  try { baseOrigin = new URL(baseUrl).origin; } catch { baseOrigin = ''; }

  html = html.replace(/http:\/\//g, 'https://');

  html = html.replace(
    /(<link[^>]+href=["'])([^"']+)(["'][^>]*>)/gi,
    (match, before, href, after) => {
      if (href.startsWith('data:') || href.startsWith(proxyOrigin)) return match;
      try {
        const resolved = new URL(href, baseUrl).href;
        return `${before}${proxyAsset}${encodeURIComponent(resolved)}${after}`;
      } catch { return match; }
    }
  );

  html = html.replace(
    /(<script[^>]+src=["'])([^"']+)(["'][^>]*>)/gi,
    (match, before, src, after) => {
      if (src.startsWith('data:') || src.startsWith(proxyOrigin)) return match;
      try {
        const resolved = new URL(src, baseUrl).href;
        return `${before}${proxyAsset}${encodeURIComponent(resolved)}${after}`;
      } catch { return match; }
    }
  );

  html = html.replace(
    /(<img[^>]+src=["'])([^"']+)(["'][^>]*>)/gi,
    (match, before, src, after) => {
      if (src.startsWith('data:') || src.startsWith(proxyOrigin)) return match;
      try {
        const resolved = new URL(src, baseUrl).href;
        return `${before}${proxyAsset}${encodeURIComponent(resolved)}${after}`;
      } catch { return match; }
    }
  );

  html = html.replace(
    /(url\s*\(\s*["']?)([^"')]+)(["']?\s*\))/gi,
    (match, before, url, after) => {
      if (url.startsWith('data:') || url.startsWith(proxyOrigin) || url.startsWith('#')) return match;
      try {
        const resolved = new URL(url, baseUrl).href;
        return `${before}${proxyAsset}${encodeURIComponent(resolved)}${after}`;
      } catch { return match; }
    }
  );

  html = html.replace(
    /(<form[^>]+action=["'])([^"']+)(["'][^>]*>)/gi,
    (match, before, action, after) => {
      if (action.startsWith('#') || action.startsWith('javascript:')) return match;
      try {
        const resolved = new URL(action, baseUrl).href;
        return `${before}${proxyRender}${encodeURIComponent(resolved)}${after}`;
      } catch { return match; }
    }
  );

  html = html.replace(
    /<meta\s+http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)["'][^>]*\/?>/gi,
    (match, redirectUrl) => {
      try {
        const resolved = new URL(redirectUrl.trim(), baseUrl).href;
        return `<!-- proxy-stripped-redirect: ${resolved} -->`;
      } catch { return match; }
    }
  );

  html = html.replace(
    /window\.location\s*=\s*["']([^"']+)["']/g,
    (match, url) => {
      try {
        const resolved = new URL(url, baseUrl).href;
        return `window.parent.postMessage({type:'proxy-navigate',url:'${resolved}'},'*')`;
      } catch { return match; }
    }
  );

  const proxyScript = `<script>
(function() {
  if (window.__proxyPatched) return;
  window.__proxyPatched = true;
  var P = '${proxyOrigin}';
  var R = P + '/api/render?url=';
  var A = P + '/api/asset?url=';

  document.addEventListener('click', function(e) {
    var a = e.target && (e.target.closest ? e.target.closest('a') : e.target);
    if (!a || a.tagName !== 'A') return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    try {
      var resolved = new URL(href, '${baseUrl}').href;
      if (/^https?:/.test(resolved)) {
        e.preventDefault();
        e.stopPropagation();
        window.parent.postMessage({ type: 'proxy-navigate', url: resolved }, '*');
      }
    } catch(err) {}
  }, true);

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (form && form.action) {
      try {
        var resolved = new URL(form.action, '${baseUrl}').href;
        if (/^https?:/.test(resolved) && resolved.indexOf(P) === -1) {
          e.preventDefault();
          window.parent.postMessage({ type: 'proxy-navigate', url: resolved }, '*');
        }
      } catch(err) {}
    }
  }, true);

  try {
    Location.prototype.assign = function(v) {
      var resolved = new URL(v, '${baseUrl}').href;
      window.parent.postMessage({ type: 'proxy-navigate', url: resolved }, '*');
    };
    Location.prototype.replace = function(v) {
      var resolved = new URL(v, '${baseUrl}').href;
      window.parent.postMessage({ type: 'proxy-navigate', url: resolved }, '*');
    };
    var hDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (hDesc && hDesc.set) {
      Object.defineProperty(Location.prototype, 'href', {
        get: hDesc.get,
        set: function(v) {
          try {
            var resolved = new URL(v, '${baseUrl}').href;
            window.parent.postMessage({ type: 'proxy-navigate', url: resolved }, '*');
          } catch(e) { hDesc.set.call(this, v); }
        },
        configurable: true
      });
    }
  } catch(e) {}
})();
</script>`;

  const baseTag = `<base href="${baseUrl}">`;
  const injection = `${baseTag}\n${proxyScript}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${injection}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${injection}</head>`);
  }
  return `<head>${injection}</head>\n${html}`;
}

function buildCleanHeaders(response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    if (!HEADERS_TO_STRIP.includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  delete headers['content-length'];
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];
  return headers;
}

function errorPage(statusCode, statusText, targetUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Proxy Error</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#12121a;border:1px solid #2a2a4a;border-radius:12px;padding:40px;max-width:500px;text-align:center}
h1{color:#ef4444;font-size:3rem;margin:0 0 8px}
h2{color:#94a3b8;font-weight:400;margin:0 0 24px;font-size:1.1rem}
p{color:#64748b;line-height:1.6;margin:0 0 16px}
code{background:#1a1a2e;padding:2px 8px;border-radius:4px;font-size:.85rem;color:#818cf8}
.hint{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:12px 16px;color:#f59e0b;font-size:.85rem;margin-top:20px}
</style></head><body><div class="card">
<h1>${statusCode}</h1><h2>${statusText}</h2>
<p>The target site returned an error from the US proxy server.</p>
<p>URL: <code>${targetUrl}</code></p>
<div class="hint">${statusCode === 403
  ? 'This site has bot/WAF protection that blocks server-side requests. Only real browsers can access it directly.'
  : statusCode === 404 ? 'The page was not found on the target server.'
  : statusCode >= 500 ? 'The target server encountered an internal error.'
  : 'The target server rejected the request.'}</div>
</div></body></html>`;
}

// ─── Routes ──────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    region: process.env.RENDER_REGION || 'local',
    service: process.env.RENDER_SERVICE_NAME || 'us-region-renderer',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/asset', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  const targetUrl = normalizeUrl(url);
  if (!targetUrl) return res.status(400).send('Invalid url');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetchWithFallback(targetUrl, {
      headers: {
        ...US_HEADERS,
        'Accept': '*/*',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'no-cors',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const headers = buildCleanHeaders(response);
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Cache-Control'] = 'public, max-age=3600';
    res.set(headers);

    const buffer = Buffer.from(await response.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    console.error(`Asset proxy error for ${targetUrl}:`, err.message);
    return res.status(502).send('Failed to fetch asset');
  }
});

app.get('/api/render', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter is required' });

  const targetUrl = normalizeUrl(url);
  if (!targetUrl) return res.status(400).json({ error: 'Invalid URL provided' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetchWithFallback(targetUrl, {
      headers: US_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      res.set({ 'Content-Type': 'text/html; charset=utf-8' });
      return res.send(errorPage(response.status, response.statusText, targetUrl));
    }

    const contentType = response.headers.get('content-type') || '';
    const headers = buildCleanHeaders(response);
    headers['X-Proxy-Region'] = process.env.RENDER_REGION || 'local';
    headers['X-Original-URL'] = targetUrl;
    headers['Access-Control-Allow-Origin'] = '*';

    if (contentType.includes('text/html')) {
      let html = await response.text();
      const proxyOrigin = getProxyOrigin(req);
      html = rewriteHtml(html, targetUrl, proxyOrigin);
      headers['Content-Type'] = 'text/html; charset=utf-8';
      res.set(headers);
      return res.send(html);
    }

    if (contentType.includes('text/css') || contentType.includes('javascript')) {
      const text = await response.text();
      res.set(headers);
      return res.send(text);
    }

    res.set(headers);
    const buffer = Buffer.from(await response.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out' });
    }
    console.error(`Render error for ${targetUrl}:`, err.code || '', err.message);
    return res.status(502).json({ error: 'Failed to fetch the URL', details: err.message, url: targetUrl });
  }
});

app.get('/api/info', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter is required' });

  const targetUrl = normalizeUrl(url);
  if (!targetUrl) return res.status(400).json({ error: 'Invalid URL provided' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetchWithFallback(targetUrl, {
      method: 'HEAD',
      headers: US_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });

    return res.json({
      status: response.status,
      statusText: response.statusText,
      headers,
      url: response.url,
      region: process.env.RENDER_REGION || 'US (proxy server)',
      service: process.env.RENDER_SERVICE_NAME || 'local-dev',
    });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Request timed out' });
    return res.status(502).json({ error: 'Failed to fetch info', details: err.message });
  }
});

// ─── Static frontend (production) ────────────────────

if (isProduction) {
  const distPath = path.join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${isProduction ? 'production' : 'development'}`);
  if (isProduction) console.log('Serving static frontend from /dist');
  console.log(`Region: ${process.env.RENDER_REGION || 'local'}`);
});
