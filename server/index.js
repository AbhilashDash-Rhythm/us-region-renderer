import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

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
const RATE_LIMIT_MAX = 30;

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
    if (now - record.start > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

const FETCH_TIMEOUT = 20_000;

const US_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
};

function normalizeUrl(raw) {
  let target = raw.trim();
  if (!/^https?:\/\//i.test(target)) {
    target = `https://${target}`;
  }
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol');
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function buildProxyScript(baseUrl) {
  return `<script>
(function() {
  var proxyBase = location.origin + '/api/render?url=';
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url && !url.startsWith(location.origin) && /^https?:/.test(url)) {
      arguments[1] = proxyBase + encodeURIComponent(url);
    }
    return originalOpen.apply(this, arguments);
  };

  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && !input.startsWith(location.origin) && /^https?:/.test(input)) {
      input = proxyBase + encodeURIComponent(input);
    }
    return origFetch.call(this, input, init);
  };

  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (!a) return;
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

  var origAssign = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
  if (origAssign && origAssign.set) {
    Object.defineProperty(window.location, 'href', {
      set: function(v) {
        try {
          var resolved = new URL(v, '${baseUrl}').href;
          window.parent.postMessage({ type: 'proxy-navigate', url: resolved }, '*');
        } catch(err) {
          origAssign.set.call(this, v);
        }
      },
      get: origAssign.get ? origAssign.get.bind(window.location) : undefined
    });
  }

  var origReplace = Location.prototype.replace;
  Location.prototype.replace = function(v) {
    try {
      var resolved = new URL(v, '${baseUrl}').href;
      window.parent.postMessage({ type: 'proxy-navigate', url: resolved }, '*');
    } catch(err) {
      origReplace.call(this, v);
    }
  };
})();
</script>`;
}

function injectBase(html, baseUrl) {
  const baseTag = `<base href="${baseUrl}">`;
  const proxyScript = buildProxyScript(baseUrl);
  const injection = `${baseTag}\n    ${proxyScript}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n    ${injection}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}\n<head>${injection}</head>`);
  }
  return `${injection}\n${html}`;
}

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

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  const targetUrl = normalizeUrl(url);
  if (!targetUrl) {
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(targetUrl, {
      headers: US_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      let html = await response.text();
      html = injectBase(html, targetUrl);

      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'X-Proxy-Region': process.env.RENDER_REGION || 'local',
        'X-Original-URL': targetUrl,
      });
      return res.send(html);
    }

    if (contentType.includes('text/css') || contentType.includes('javascript')) {
      const text = await response.text();
      res.set('Content-Type', contentType);
      return res.send(text);
    }

    res.set('Content-Type', contentType);
    const buffer = Buffer.from(await response.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out', details: 'The target URL took too long to respond.' });
    }
    console.error('Render error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch the URL', details: err.message });
  }
});

app.get('/api/info', rateLimit, async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  const targetUrl = normalizeUrl(url);
  if (!targetUrl) {
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(targetUrl, {
      method: 'HEAD',
      headers: US_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return res.json({
      status: response.status,
      statusText: response.statusText,
      headers,
      url: response.url,
      region: process.env.RENDER_REGION || 'US (proxy server)',
      service: process.env.RENDER_SERVICE_NAME || 'local-dev',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out' });
    }
    return res.status(502).json({ error: 'Failed to fetch info', details: err.message });
  }
});

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
  if (isProduction) {
    console.log('Serving static frontend from /dist');
  }
  console.log(`Region: ${process.env.RENDER_REGION || 'local'}`);
});
