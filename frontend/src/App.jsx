import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || window.location.origin).replace(/\/$/, "");

function formatDate(value, timezone, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
    timeZone: timezone || "Asia/Kolkata",
  }).format(date);
}

function relativeTime(value) {
  if (!value) return "No detections yet";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "No detections yet";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function App() {
  const [period, setPeriod] = useState(7);
  const [data, setData] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreWind, setLoadingMoreWind] = useState(false);

  const loadDashboard = useCallback(async (signal) => {
    setState("loading");
    setError("");
    try {
      if (!API_BASE_URL) {
        throw new Error("Monitoring service is not configured. Set VITE_API_BASE_URL and rebuild the frontend.");
      }
      const response = await fetch(`${API_BASE_URL}/api/dashboard?period=${period}`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Unable to load monitoring data.");
      setData(payload);
      setState("ready");
    } catch (requestError) {
      if (requestError.name === "AbortError") return;
      setState("error");
      setError(requestError.message || "Unable to load monitoring data. Please try again.");
    }
  }, [period]);

  const loadMoreHistory = useCallback(async () => {
    if (!data?.history_has_more || loadingMore) return;
    setLoadingMore(true);
    try {
      const offset = data.recent_detections?.length || 0;
      const response = await fetch(`${API_BASE_URL}/api/dashboard?period=${period}&history_offset=${offset}&history_limit=5`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Unable to load more history.");
      setData((current) => ({
        ...payload,
        recent_detections: [...(current?.recent_detections || []), ...(payload.recent_detections || [])],
      }));
    } catch (requestError) {
      setError(requestError.message || "Unable to load more history.");
    } finally {
      setLoadingMore(false);
    }
  }, [data, loadingMore, period]);

  const loadMoreWindHistory = useCallback(async () => {
    if (!data?.wind_history_has_more || loadingMoreWind) return;
    setLoadingMoreWind(true);
    try {
      const offset = data.wind_history?.length || 0;
      const response = await fetch(`${API_BASE_URL}/api/dashboard?period=${period}&wind_offset=${offset}&wind_limit=5`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Unable to load more wind history.");
      setData((current) => ({
        ...current,
        ...payload,
        wind_history: [...(current?.wind_history || []), ...(payload.wind_history || [])],
      }));
    } catch (requestError) {
      setError(requestError.message || "Unable to load more wind history.");
    } finally {
      setLoadingMoreWind(false);
    }
  }, [data, loadingMoreWind, period]);

  useEffect(() => {
    const controller = new AbortController();
    loadDashboard(controller.signal);
    return () => controller.abort();
  }, [loadDashboard]);

  const todayLabel = useMemo(() => new Intl.DateTimeFormat("en-IN", { dateStyle: "full" }).format(new Date()), []);

  if (state === "loading" && !data) return <LoadingScreen todayLabel={todayLabel} />;

  return (
    <div className="app-shell">
      <Header data={data} todayLabel={todayLabel} />
      <main className="page-content">
        {state === "error" && (
          <div className="alert error-alert" role="alert">
            <span>{error}</span>
            <button className="text-button" onClick={() => loadDashboard()}>Try again</button>
          </div>
        )}
        {data && <Dashboard data={data} period={period} setPeriod={setPeriod} onLoadMore={loadMoreHistory} loadingMore={loadingMore} onLoadMoreWind={loadMoreWindHistory} loadingMoreWind={loadingMoreWind} />}
      </main>
      <footer className="footer">Sickle Innovations Pvt Ltd · Smart Aphid Monitoring · Read-only customer view</footer>
    </div>
  );
}

function Header({ data, todayLabel }) {
  const status = data?.health?.status;
  const statusLabel = status === "online" ? "Online" : status === "offline" ? "Offline" : "Telemetry unavailable";
  return (
    <header className="topbar">
      <div className="brand-block">
        <img className="brand-logo" src="/brand/sickle-innovations-logo.png" alt="Sickle Innovations Pvt Ltd logo" />
        <div>
          <p className="eyebrow">Sickle Innovations Pvt Ltd</p>
          <h1>Smart Aphid Monitoring</h1>
        </div>
      </div>
      <div className="header-meta">
        <div className="date-label">{todayLabel}</div>
        <div className={`status-pill status-${status || "unknown"}`}>
          <span className="status-dot" />
          {statusLabel}
        </div>
        <div className="trap-label">{data?.trap_name || "Trap 001"}</div>
      </div>
    </header>
  );
}

function Dashboard({ data, period, setPeriod, onLoadMore, loadingMore, onLoadMoreWind, loadingMoreWind }) {
  const kpis = data.kpis || {};
  const activity = kpis.activity || {};
  const latest = data.latest_detection;
  return (
    <>
      <section className="intro-row">
        <div>
          <p className="eyebrow">Monitoring overview</p>
          <h2>Trap activity at a glance</h2>
          <p className="muted">Live results from the connected monitoring system.</p>
        </div>
        <div className="refresh-note">Updated {formatDate(data.generated_at, data.timezone)}</div>
      </section>

      <section className="kpi-grid" aria-label="Monitoring summary">
        <KpiCard label="Aphids detected today" value={kpis.aphids_today} note="Sum of today’s detections" />
        <KpiCard
          label="Aphid activity"
          value={activity.label || "Not enough data"}
          note={activity.percentage === null ? "Not enough historical data" : `${Math.abs(activity.percentage)}% vs previous ${period === 1 ? "day" : `${period} days`}`}
          tone={activity.direction}
        />
        <KpiCard label="Images analyzed" value={kpis.images_today} note="Processed detections today" />
        <KpiCard label="Last detection" value={relativeTime(latest?.captured_at)} note={latest ? formatDate(latest.captured_at, data.timezone) : "No detections yet"} compact />
      </section>

      <section className="panel trend-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Detection history</p>
            <h3>Aphid activity</h3>
          </div>
          <div className="period-switcher" role="group" aria-label="Trend period">
            {[1, 7, 30].map((option) => (
              <button key={option} className={period === option ? "selected" : ""} onClick={() => setPeriod(option)}>{option === 1 ? "Last day" : `${option} days`}</button>
            ))}
          </div>
        </div>
        <ActivityChart points={data.trend || []} timezone={data.timezone} />
      </section>

      <section className="content-grid">
        <LatestDetection detection={latest} timezone={data.timezone} />
        <SystemHealth health={data.health} timezone={data.timezone} />
      </section>

      <section className="history-grid">
        <RecentDetections rows={data.recent_detections || []} timezone={data.timezone} hasMore={data.history_has_more} onLoadMore={onLoadMore} loadingMore={loadingMore} />
        <WindHistory rows={data.wind_history || []} timezone={data.timezone} period={period} hasMore={data.wind_history_has_more} onLoadMore={onLoadMoreWind} loadingMore={loadingMoreWind} />
      </section>
    </>
  );
}

function KpiCard({ label, value, note, tone = "", compact = false }) {
  return (
    <article className={`kpi-card ${tone}`}>
      <p className="kpi-label">{label}</p>
      <div className={`kpi-value ${compact ? "compact-value" : ""}`}>{value ?? "—"}</div>
      <p className="kpi-note">{note}</p>
    </article>
  );
}

function ActivityChart({ points, timezone }) {
  if (!points.length) return <EmptyState message="No detection data available yet." />;
  const width = 900;
  const height = 290;
  const padding = { top: 24, right: 24, bottom: 52, left: 52 };
  const max = Math.max(...points.map((point) => Number(point.count) || 0), 1);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const coordinates = points.map((point, index) => ({
    x: points.length === 1 ? padding.left + plotWidth / 2 : padding.left + (index / (points.length - 1)) * plotWidth,
    y: padding.top + plotHeight - ((Number(point.count) || 0) / max) * plotHeight,
    ...point,
  }));
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <div className="chart-wrap">
      <svg className="activity-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Aphid activity by day">
        {[0, 0.5, 1].map((ratio) => {
          const y = padding.top + plotHeight - ratio * plotHeight;
          return <line key={ratio} x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="grid-line" />;
        })}
        <polyline points={line} className="chart-line" />
        {coordinates.map((point) => (
          <g key={point.date}>
            <circle cx={point.x} cy={point.y} r="5" className="chart-point" />
            <text x={point.x} y={height - 20} textAnchor="middle" className="axis-label">{formatDate(`${point.date}T12:00:00`, timezone, false)}</text>
          </g>
        ))}
        <text x={padding.left - 10} y={padding.top + 4} textAnchor="end" className="axis-label">{max}</text>
        <text x={padding.left - 10} y={padding.top + plotHeight + 4} textAnchor="end" className="axis-label">0</text>
      </svg>
    </div>
  );
}

function LatestDetection({ detection, timezone }) {
  return (
    <section className="panel latest-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Most recent record</p><h3>Latest detection</h3></div>
      </div>
      {!detection ? <EmptyState message="No detections recorded yet." /> : (
        <div className="latest-content">
          <ImageFrame detection={detection} large />
          <div className="latest-details">
            <div className="count-display"><strong>{detection.insect_count}</strong><span>aphids detected</span></div>
            <p className="capture-time">{formatDate(detection.captured_at, timezone)}</p>
            <ImageLinks detection={detection} />
          </div>
        </div>
      )}
    </section>
  );
}

function ImageFrame({ detection, large = false }) {
  const imageUrl = detection?.result_image_url || detection?.original_image_url || detection?.image_url;
  if (!imageUrl) return <div className={`image-frame unavailable ${large ? "large" : ""}`}>Image unavailable</div>;
  const label = detection?.result_image_url ? "Detection result" : "Original image";
  return <div className={`image-frame ${large ? "large" : ""}`}><img src={imageUrl} alt={label} loading={large ? "eager" : "lazy"} onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement.classList.add("unavailable"); event.currentTarget.parentElement.append("Image unavailable"); }} /></div>;
}

function ImageLinks({ detection, compact = false }) {
  const links = [];
  if (detection?.result_image_url) links.push({ label: "View result", url: detection.result_image_url });
  if (detection?.original_image_url && detection.original_image_url !== detection.result_image_url) links.push({ label: "View original", url: detection.original_image_url });
  if (!links.length && detection?.image_url) links.push({ label: "View image", url: detection.image_url });
  if (!links.length) return null;
  return <div className={`image-links ${compact ? "compact" : ""}`}>{links.map((link) => <a key={link.label} className={compact ? "view-link" : "primary-button"} href={link.url} target="_blank" rel="noreferrer">{link.label}</a>)}</div>;
}

function SystemHealth({ health, timezone }) {
  const fields = health?.fields || {};
  const entries = [
    ["Battery", fields.battery_percent == null ? null : `${fields.battery_percent}%`],
    ["Voltage", fields.battery_voltage == null ? null : `${fields.battery_voltage} V`],
    ["Wind direction", fields.wind_direction],
    ["Wind angle", fields.wind_angle == null ? null : `${fields.wind_angle}°`],
  ].filter(([, value]) => value != null && value !== "");
  return (
    <section className="panel health-panel">
      <div className="panel-heading"><div><p className="eyebrow">Device telemetry</p><h3>System health</h3></div></div>
      {!health?.available ? <EmptyState message="Telemetry unavailable." /> : (
        <>
          <div className="health-status"><span className={`status-dot status-dot-${health.status}`} /><span>{health.status === "online" ? "Device online" : "Device offline"}</span></div>
          <div className="health-list">
            <HealthRow label="Last communication" value={formatDate(health.last_communication, timezone)} />
            {entries.map(([label, value]) => <HealthRow key={label} label={label} value={value} />)}
          </div>
        </>
      )}
    </section>
  );
}

function HealthRow({ label, value }) { return <div className="health-row"><span>{label}</span><strong>{value}</strong></div>; }

function WindHistory({ rows, timezone, period, hasMore, onLoadMore, loadingMore }) {
  return (
    <section className="panel wind-history-panel">
      <div className="panel-heading"><div><p className="eyebrow">Device telemetry</p><h3>Wind history</h3></div><span className="wind-history-note">Last {period === 1 ? "day" : `${period} days`}</span></div>
      {!rows.length ? <EmptyState message="No wind readings available for this period." /> : (
        <>
        <div className="wind-table-wrap">
          <table className="wind-table">
            <thead><tr><th>Time</th><th>Direction</th><th>Angle</th><th>Battery</th><th>Voltage</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={`${row.recorded_at}-${index}`}><td><strong>{formatDate(row.recorded_at, timezone)}</strong><span className="table-muted">{relativeTime(row.recorded_at)}</span></td><td>{row.wind_direction || "—"}</td><td>{row.wind_angle == null ? "—" : `${row.wind_angle}°`}</td><td>{row.battery_percent == null ? "—" : `${row.battery_percent}%`}</td><td>{row.battery_voltage == null ? "—" : `${row.battery_voltage} V`}</td></tr>)}</tbody>
          </table>
        </div>
        {hasMore && <div className="history-more"><button className="secondary-button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show more"}</button></div>}
        </>
      )}
    </section>
  );
}

function RecentDetections({ rows, timezone, hasMore, onLoadMore, loadingMore }) {
  return (
    <section className="panel recent-panel">
      <div className="panel-heading"><div><p className="eyebrow">History</p><h3>Recent detections</h3></div></div>
      {!rows.length ? <EmptyState message="No detections recorded yet." /> : (
        <>
          <div className="recent-list">
            {rows.map((row, index) => (
              <div className="recent-row" key={`${row.captured_at}-${index}`}>
                <ImageFrame detection={row} />
                <div className="recent-time"><strong>{formatDate(row.captured_at, timezone)}</strong><span>{relativeTime(row.captured_at)}</span></div>
                <div className="recent-count"><strong>{row.insect_count}</strong><span>aphids</span></div>
                <div className={`record-status ${row.image_available ? "available" : "missing"}`}>{row.image_available ? "Image available" : "Image unavailable"}</div>
                <ImageLinks detection={row} compact />
              </div>
            ))}
          </div>
          {hasMore && <div className="history-more"><button className="secondary-button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show more"}</button></div>}
        </>
      )}
    </section>
  );
}

function EmptyState({ message }) { return <div className="empty-state">{message}</div>; }
function LoadingScreen({ todayLabel }) { return <div className="app-shell"><header className="topbar"><div className="brand-block"><img className="brand-logo" src="/brand/sickle-innovations-logo.png" alt="Sickle Innovations Pvt Ltd logo" /><div><p className="eyebrow">Sickle Innovations Pvt Ltd</p><h1>Smart Aphid Monitoring</h1></div></div><div className="header-meta"><div className="date-label">{todayLabel}</div><div className="status-pill status-unknown"><span className="status-dot" />Loading</div><div className="trap-label">Trap 001</div></div></header><main className="page-content"><div className="skeleton skeleton-intro" /><div className="kpi-grid">{[1, 2, 3, 4].map((item) => <div className="skeleton skeleton-card" key={item} />)}</div><div className="skeleton skeleton-chart" /><div className="skeleton skeleton-chart" /></main></div>; }

export default App;
