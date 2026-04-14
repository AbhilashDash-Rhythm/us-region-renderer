import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get('/api/render', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'X-Forwarded-For': '104.28.210.170', // US-based IP (Cloudflare, San Francisco)
      },
      redirect: 'follow',
      timeout: 15000,
    });

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      let html = await response.text();

      const baseTag = `<base href="${targetUrl}">`;
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${baseTag}`);
      } else if (html.includes('<html>')) {
        html = html.replace('<html>', `<html><head>${baseTag}</head>`);
      } else {
        html = baseTag + html;
      }

      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    res.set('Content-Type', contentType);
    const buffer = await response.buffer();
    return res.send(buffer);
  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(502).json({
      error: 'Failed to fetch the URL',
      details: err.message,
    });
  }
});

app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;

    const response = await fetch(targetUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Forwarded-For': '104.28.210.170',
      },
      redirect: 'follow',
      timeout: 10000,
    });

    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return res.json({
      status: response.status,
      statusText: response.statusText,
      headers,
      url: response.url,
      region: 'US (proxy server)',
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Failed to fetch info',
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
  console.log('Serving requests with US-region headers');
});
