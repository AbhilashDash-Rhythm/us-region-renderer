import React, { useState, useCallback, useRef } from 'react';
import './App.css';

const DEVICE_PRESETS = [
  { name: 'Desktop', width: '100%', height: '100%', icon: '🖥' },
  { name: 'Tablet', width: '768px', height: '1024px', icon: '📱' },
  { name: 'Mobile', width: '375px', height: '667px', icon: '📲' },
];

function App() {
  const [url, setUrl] = useState('');
  const [renderedUrl, setRenderedUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(null);
  const [activeDevice, setActiveDevice] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  const iframeRef = useRef(null);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      if (!url.trim()) return;

      setLoading(true);
      setError('');
      setInfo(null);

      const targetUrl = url.startsWith('http') ? url : `https://${url}`;
      const proxyUrl = `/api/render?url=${encodeURIComponent(targetUrl)}`;

      try {
        const infoRes = await fetch(`/api/info?url=${encodeURIComponent(targetUrl)}`);
        const infoData = await infoRes.json();

        if (infoRes.ok) {
          setInfo(infoData);
        }
      } catch {
        // info fetch is optional
      }

      setRenderedUrl(proxyUrl);
      setLoading(false);
    },
    [url]
  );

  const handleIframeLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setLoading(false);
    setError('Failed to load the page. The site may block proxied requests.');
  }, []);

  const handleRefresh = useCallback(() => {
    if (iframeRef.current && renderedUrl) {
      setLoading(true);
      iframeRef.current.src = renderedUrl + '&t=' + Date.now();
    }
  }, [renderedUrl]);

  const device = DEVICE_PRESETS[activeDevice];

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <div className="logo">
            <div className="logo-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </div>
            <h1>US Region Renderer</h1>
          </div>
          <span className="badge">
            <span className="badge-dot" />
            US Region
          </span>
        </div>
      </header>

      <main className="main">
        <form className="url-form" onSubmit={handleSubmit}>
          <div className="input-group">
            <div className="input-prefix">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Enter a URL (e.g., example.com)"
              className="url-input"
              spellCheck={false}
            />
            <button
              type="submit"
              className="render-btn"
              disabled={loading || !url.trim()}
            >
              {loading ? (
                <span className="spinner" />
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="13 17 18 12 13 7" />
                    <polyline points="6 17 11 12 6 7" />
                  </svg>
                  Render
                </>
              )}
            </button>
          </div>
        </form>

        {error && (
          <div className="error-banner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            {error}
          </div>
        )}

        {renderedUrl && (
          <div className="preview-section">
            <div className="toolbar">
              <div className="toolbar-left">
                <div className="device-switcher">
                  {DEVICE_PRESETS.map((d, i) => (
                    <button
                      key={d.name}
                      className={`device-btn ${i === activeDevice ? 'active' : ''}`}
                      onClick={() => setActiveDevice(i)}
                      title={d.name}
                    >
                      {d.icon} {d.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="toolbar-right">
                <button className="icon-btn" onClick={() => setShowInfo(!showInfo)} title="Page info">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </button>
                <button className="icon-btn" onClick={handleRefresh} title="Refresh">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>
              </div>
            </div>

            {showInfo && info && (
              <div className="info-panel">
                <div className="info-row">
                  <span className="info-label">Status</span>
                  <span className={`info-value status-${info.status < 400 ? 'ok' : 'err'}`}>
                    {info.status} {info.statusText}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Final URL</span>
                  <span className="info-value">{info.url}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Region</span>
                  <span className="info-value">{info.region}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Content-Type</span>
                  <span className="info-value">{info.headers?.['content-type'] || 'N/A'}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Server</span>
                  <span className="info-value">{info.headers?.server || 'N/A'}</span>
                </div>
              </div>
            )}

            <div className="preview-container">
              <div
                className="iframe-wrapper"
                style={{
                  width: device.width,
                  height: device.height,
                  maxWidth: '100%',
                }}
              >
                {loading && (
                  <div className="loading-overlay">
                    <div className="loading-content">
                      <span className="spinner large" />
                      <p>Fetching from US region...</p>
                    </div>
                  </div>
                )}
                <iframe
                  ref={iframeRef}
                  src={renderedUrl}
                  title="Rendered Page"
                  className="preview-iframe"
                  onLoad={handleIframeLoad}
                  onError={handleIframeError}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              </div>
            </div>
          </div>
        )}

        {!renderedUrl && !error && (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </div>
            <h2>Render any website from the US</h2>
            <p>Enter a URL above to view it as if you were browsing from a US-based location. The page is fetched through a US-region proxy server.</p>
            <div className="features">
              <div className="feature">
                <div className="feature-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </div>
                <div>
                  <h3>US-Based Requests</h3>
                  <p>All requests are routed with US-region headers and IP geolocation</p>
                </div>
              </div>
              <div className="feature">
                <div className="feature-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </div>
                <div>
                  <h3>Responsive Preview</h3>
                  <p>Switch between desktop, tablet, and mobile viewports</p>
                </div>
              </div>
              <div className="feature">
                <div className="feature-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </div>
                <div>
                  <h3>Page Info</h3>
                  <p>View HTTP status, headers, and response details</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
