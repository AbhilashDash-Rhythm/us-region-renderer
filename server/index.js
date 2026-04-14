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
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 120;

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

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
};

function getAgent(url) {
  return url.startsWith('https') ? httpsAgent : httpAgent;
}

async function proxyFetch(targetUrl, options = {}) {
  const opts = { ...options, agent: getAgent(targetUrl) };
  try {
    return await fetch(targetUrl, opts);
  } catch (err) {
    const alt = targetUrl.startsWith('https://')
      ? targetUrl.replace('https://', 'http://')
      : targetUrl.replace('http://', 'https://');
    return fetch(alt, { ...opts, agent: getAgent(alt) });
  }
}

function normalizeUrl(raw) {
  let target = (raw || '').trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    return parsed.href;
  } catch { return null; }
}

const STRIP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'x-content-type-options',
  'strict-transport-security', 'permissions-policy',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy',
  'cross-origin-resource-policy', 'content-length',
  'content-encoding', 'transfer-encoding',
]);

function cleanHeaders(response) {
  const h = {};
  response.headers.forEach((v, k) => {
    if (!STRIP_HEADERS.has(k.toLowerCase())) h[k] = v;
  });
  h['Access-Control-Allow-Origin'] = '*';
  return h;
}

function proxyOrigin(req) {
  return `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
}

function rewriteHtml(html, baseUrl, origin) {
  const P = `${origin}/proxy/`;

  function toProxyUrl(rawUrl) {
    try {
      const abs = new URL(rawUrl, baseUrl).href;
      return `${P}${encodeURIComponent(abs)}`;
    } catch { return rawUrl; }
  }

  html = html.replace(/http:\/\//g, 'https://');

  html = html.replace(
    /(<(?:link|script|img|source|video|audio|embed|iframe)[^>]*?\s(?:src|href)=["'])([^"']+)(["'])/gi,
    (m, pre, url, post) => {
      if (/^(?:data:|blob:|javascript:|#|mailto:)/.test(url)) return m;
      return `${pre}${toProxyUrl(url)}${post}`;
    }
  );

  html = html.replace(
    /(<(?:form)[^>]*?\saction=["'])([^"']*)(["'])/gi,
    (m, pre, url, post) => {
      if (!url || url.startsWith('#') || url.startsWith('javascript:')) return m;
      return `${pre}${origin}/api/render?url=${encodeURIComponent(new URL(url, baseUrl).href)}${post}`;
    }
  );

  html = html.replace(
    /(url\s*\(\s*["']?)(?!data:|blob:|#)([^"')]+)(["']?\s*\))/gi,
    (m, pre, url, post) => {
      try { return `${pre}${toProxyUrl(url)}${post}`; }
      catch { return m; }
    }
  );

  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (m, open, css, close) => {
      const rewritten = css.replace(
        /@import\s+(?:url\s*\()?\s*["']?([^"');\s]+)["']?\s*\)?/gi,
        (im, url) => `@import url('${toProxyUrl(url)}')`
      );
      return `${open}${rewritten}${close}`;
    }
  );

  html = html.replace(
    /<meta\s+http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)["'][^>]*\/?>/gi,
    () => ''
  );

  html = html.replace(
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/g,
    (m, url) => {
      try {
        const abs = new URL(url, baseUrl).href;
        return `window.parent.postMessage({type:'proxy-navigate',url:'${abs}'},'*')`;
      } catch { return m; }
    }
  );

  const script = `<script>(function(){
if(window.__px) return; window.__px=1;
var O='${origin}', B='${baseUrl}';
document.addEventListener('click',function(e){
  var a=e.target&&(e.target.closest?e.target.closest('a'):null);
  if(!a||a.tagName!=='A') return;
  var h=a.getAttribute('href');
  if(!h||h.startsWith('#')||h.startsWith('javascript:')) return;
  try{var r=new URL(h,B).href;
    if(/^https?:/.test(r)){e.preventDefault();e.stopPropagation();
      window.parent.postMessage({type:'proxy-navigate',url:r},'*');
  }}catch(x){}
},true);
document.addEventListener('submit',function(e){
  var f=e.target; if(!f||!f.action) return;
  try{var r=new URL(f.action,B).href;
    if(/^https?:/.test(r)&&r.indexOf(O)===-1){e.preventDefault();
      window.parent.postMessage({type:'proxy-navigate',url:r},'*');
  }}catch(x){}
},true);
try{
  Location.prototype.assign=function(v){try{window.parent.postMessage({type:'proxy-navigate',url:new URL(v,B).href},'*')}catch(x){}};
  Location.prototype.replace=function(v){try{window.parent.postMessage({type:'proxy-navigate',url:new URL(v,B).href},'*')}catch(x){}};
  var d=Object.getOwnPropertyDescriptor(Location.prototype,'href');
  if(d&&d.set){Object.defineProperty(Location.prototype,'href',{get:d.get,set:function(v){
    try{window.parent.postMessage({type:'proxy-navigate',url:new URL(v,B).href},'*')}catch(x){d.set.call(this,v)}
  },configurable:true})}
}catch(x){}
})();</script>`;

  const base = `<base href="${origin}/proxy/${encodeURIComponent(baseUrl)}/">`;
  const inject = `${base}\n${script}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, m => `${m}\n${inject}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, m => `${m}\n<head>${inject}</head>`);
  }
  return `<head>${inject}</head>\n${html}`;
}

function errorPage(code, text, url) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.c{background:#12121a;border:1px solid #2a2a4a;border-radius:12px;padding:40px;max-width:500px;text-align:center}
h1{color:#ef4444;font-size:3rem;margin:0 0 8px}h2{color:#94a3b8;font-weight:400;margin:0 0 24px}
p{color:#64748b;line-height:1.6;margin:0 0 12px}code{background:#1a1a2e;padding:2px 8px;border-radius:4px;color:#818cf8;font-size:.85rem}
.h{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:12px 16px;color:#f59e0b;font-size:.85rem;margin-top:16px}
</style></head><body><div class="c"><h1>${code}</h1><h2>${text}</h2>
<p>The target site returned this error from the US proxy.</p><p>URL: <code>${url}</code></p>
<div class="h">${code===403?'This site has bot/WAF protection blocking server requests.':code===404?'Page not found.':code>=500?'Server error on the target site.':'The request was rejected.'}</div>
</div></body></html>`;
}

// ─── ROUTES ──────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    region: process.env.RENDER_REGION || 'local',
    service: process.env.RENDER_SERVICE_NAME || 'us-region-renderer',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/render', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter is required' });

  const targetUrl = normalizeUrl(url);
  if (!targetUrl) return res.status(400).json({ error: 'Invalid URL provided' });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await proxyFetch(targetUrl, {
      headers: { ...BROWSER_HEADERS, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1' },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(errorPage(response.status, response.statusText, targetUrl));
    }

    const ct = response.headers.get('content-type') || '';
    const headers = cleanHeaders(response);
    headers['X-Proxy-Region'] = process.env.RENDER_REGION || 'local';
    headers['X-Original-URL'] = targetUrl;

    if (ct.includes('text/html')) {
      let html = await response.text();
      html = rewriteHtml(html, response.url || targetUrl, proxyOrigin(req));
      headers['Content-Type'] = 'text/html; charset=utf-8';
      res.set(headers);
      return res.send(html);
    }

    res.set(headers);
    const buf = Buffer.from(await response.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Request timed out' });
    console.error(`Render error [${targetUrl}]:`, err.message);
    return res.status(502).json({ error: 'Failed to fetch', details: err.message, url: targetUrl });
  }
});

app.get('/api/info', rateLimit, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const targetUrl = normalizeUrl(url);
  if (!targetUrl) return res.status(400).json({ error: 'Invalid URL' });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await proxyFetch(targetUrl, {
      method: 'HEAD', headers: BROWSER_HEADERS, redirect: 'follow', signal: controller.signal,
    });
    clearTimeout(timer);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    return res.json({ status: response.status, statusText: response.statusText, headers, url: response.url, region: process.env.RENDER_REGION || 'US (proxy)', service: process.env.RENDER_SERVICE_NAME || 'local-dev' });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Timed out' });
    return res.status(502).json({ error: 'Failed', details: err.message });
  }
});

// Catch-all proxy route: /proxy/<encoded-url> serves any resource through the proxy
app.get('/proxy/:encodedUrl(*)', rateLimit, async (req, res) => {
  const raw = decodeURIComponent(req.params.encodedUrl);
  const targetUrl = normalizeUrl(raw);
  if (!targetUrl) return res.status(400).send('Invalid URL');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await proxyFetch(targetUrl, {
      headers: { ...BROWSER_HEADERS, 'Accept': '*/*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'no-cors' },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    const ct = response.headers.get('content-type') || '';
    const headers = cleanHeaders(response);
    headers['Cache-Control'] = 'public, max-age=3600';

    if (ct.includes('text/html')) {
      let html = await response.text();
      html = rewriteHtml(html, response.url || targetUrl, proxyOrigin(req));
      headers['Content-Type'] = 'text/html; charset=utf-8';
      res.set(headers);
      return res.send(html);
    }

    if (ct.includes('text/css')) {
      let css = await response.text();
      const origin = proxyOrigin(req);
      css = css.replace(
        /url\s*\(\s*["']?(?!data:|blob:|#)([^"')]+)["']?\s*\)/gi,
        (m, url) => {
          try {
            const abs = new URL(url, targetUrl).href;
            return `url('${origin}/proxy/${encodeURIComponent(abs)}')`;
          } catch { return m; }
        }
      );
      css = css.replace(
        /@import\s+(?:url\s*\()?\s*["']?([^"');\s]+)["']?\s*\)?/gi,
        (m, url) => {
          try {
            const abs = new URL(url, targetUrl).href;
            return `@import url('${origin}/proxy/${encodeURIComponent(abs)}')`;
          } catch { return m; }
        }
      );
      res.set(headers);
      return res.send(css);
    }

    res.set(headers);
    const buf = Buffer.from(await response.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).send('Timeout');
    console.error(`Proxy error [${targetUrl}]:`, err.message);
    return res.status(502).send('Proxy error');
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
