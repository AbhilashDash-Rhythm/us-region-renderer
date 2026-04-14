# US Region Renderer

A Node.js + React application that proxies web page requests through a US-region backend server. Deploy the backend on [Render.com](https://render.com) in a US region (Oregon/Ohio) so that all outbound requests originate from a US IP address. The React frontend sends URLs to the backend, which fetches the page and returns the HTML for display.

## Architecture

```
┌──────────────┐        ┌─────────────────────────┐        ┌──────────────┐
│              │  POST   │    Node.js Express       │  GET   │              │
│  React App   │ ──────> │    (Render.com, US)      │ ──────>│ Target Site  │
│  (Browser)   │ <────── │    /api/render?url=...   │ <──────│              │
│              │  HTML   │    /api/info?url=...      │  HTML  │              │
└──────────────┘        └─────────────────────────┘        └──────────────┘
```

1. User enters a URL in the React frontend
2. React sends the URL to the Express backend (`/api/render`)
3. The backend (hosted in a US region on Render.com) fetches the target page with US-based headers
4. The backend injects a `<base>` tag and returns the HTML to the frontend
5. The frontend displays the page in an iframe

## Local Development

```bash
# Install dependencies
npm install

# Run both frontend and backend concurrently
npm run dev
```

- Frontend: http://localhost:5173 (Vite dev server with proxy to backend)
- Backend: http://localhost:3001

## Deploy to Render.com

### Option 1: One-Click Blueprint

1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) > **New** > **Blueprint**
3. Connect your GitHub repo — Render reads `render.yaml` automatically
4. Click **Apply** — it will create a web service in the **Oregon** region

### Option 2: Manual Setup

1. Go to [Render Dashboard](https://dashboard.render.com) > **New** > **Web Service**
2. Connect your GitHub/GitLab repo
3. Configure:
   - **Name**: `us-region-renderer`
   - **Region**: `Oregon` (US West) or `Ohio` (US East)
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
4. Add environment variable: `NODE_ENV` = `production`
5. Click **Create Web Service**

Your app will be live at `https://us-region-renderer.onrender.com`.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/render?url=<URL>` | GET | Fetches the target URL and returns its HTML with an injected `<base>` tag |
| `/api/info?url=<URL>` | GET | Returns HTTP status, headers, and metadata for the target URL |
| `/api/health` | GET | Returns server status, region, and service name |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` (dev) / `10000` (Render) | Server port |
| `NODE_ENV` | `development` | Set to `production` for Render deployment |
| `ALLOWED_ORIGINS` | `localhost:5173,localhost:3001` | Comma-separated CORS origins |
| `VITE_API_URL` | _(empty)_ | Backend URL for the React app (leave empty for same-origin) |

## Project Structure

```
us-region-renderer/
├── server/
│   └── index.js          # Express proxy server
├── src/
│   ├── App.jsx           # React frontend
│   ├── App.css           # Component styles
│   ├── index.css          # Global styles
│   └── main.jsx          # React entry point
├── index.html            # HTML template
├── vite.config.js        # Vite config with dev proxy
├── render.yaml           # Render.com Blueprint
├── package.json          # Dependencies and scripts
└── .env.example          # Environment variable template
```
