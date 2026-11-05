import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import StickySheet from "./StickySheet.jsx";
import WindHistory from "./WindHistory.jsx";
import ImageSessions from "./ImageSessions.jsx";
import { ImageFrame, ImageLinks } from "./ImagePreview.jsx";

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

const DIRECTION_LABELS = {
  N: "North", NE: "Northeast", E: "East", SE: "Southeast",
  S: "South", SW: "Southwest", W: "West", NW: "Northwest",
};

function normalizeTelemetryCode(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[\s–—-]+/g, "_");
}

function telemetryDisplay(statusValue, directionValue) {
  const status = normalizeTelemetryCode(statusValue);
  const direction = normalizeTelemetryCode(directionValue);
  const statusAliases = {
    POWER_FAIL_HOME: { label: "Power Failure — Home Position", tone: "warning" },
    DAILY_HOME: { label: "Daily Home Position", tone: "home" },
    H: { label: "Home Position", tone: "home" },
    SUCCESS: { label: "Normal", tone: "normal" },
  };
  if (statusAliases[status] && status !== "SUCCESS") return { ...statusAliases[status], secondary: "" };
  if (DIRECTION_LABELS[direction]) {
    return { label: DIRECTION_LABELS[direction], tone: "direction", secondary: status === "SUCCESS" ? "Hourly" : "" };
  }
  if (statusAliases[status]) return { ...statusAliases[status], secondary: "" };
  if (DIRECTION_LABELS[status]) return { label: DIRECTION_LABELS[status], tone: "direction", secondary: "" };
  return { label: directionValue || statusValue || "—", tone: "neutral", secondary: "" };
}

function App() {
  const [period, setPeriod] = useState(7);
  const [data, setData] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const imageRequest = useRef(0);
  const imageDates = useRef({});
  const imageBusy = useRef(false);
  const imageOffset = useRef(0);
  const [imageError, setImageError] = useState("");

  const loadDashboard = useCallback(async (signal) => {
    setState("loading");
    setError("");
    try {
      if (!API_BASE_URL) {
        throw new Error("Monitoring service is not configured. Set VITE_API_BASE_URL and rebuild the frontend.");
      }
      const response = await fetch(`${API_BASE_URL}/api/dashboard?period=${period}&include_wind_history=false`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Unable to load monitoring data.");
      if (signal?.aborted) return;
      imageOffset.current = (payload.history_offset || 0) + (payload.recent_detections?.length || 0);
      setData(payload);
      setState("ready");
    } catch (requestError) {
      if (requestError.name === "AbortError") return;
      setState("error");
      setError(requestError.message || "Unable to load monitoring data. Please try again.");
    }
  }, [period]);

  const loadImagePage = useCallback(async (dates, reset = false) => {
    if (imageBusy.current && !reset) return;
    const requestId = ++imageRequest.current;
    imageBusy.current = true;
    setLoadingMore(true);
    setImageError("");
    try {
      const offset = reset ? 0 : imageOffset.current;
      const params = new URLSearchParams({ period: String(period), offset: String(offset), limit: '20', ...dates });
      const response = await fetch(`${API_BASE_URL}/api/images?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || 'Unable to load image history.');
      if (requestId !== imageRequest.current) return;
      imageDates.current = dates;
      imageOffset.current = payload.offset + payload.rows.length;
      setData(current => {
        const previous = reset ? [] : current?.recent_detections || [];
        const unique = new Map([...previous, ...payload.rows].map(row => [row.id ?? row.device_id + ':' + row.captured_at, row]));
        const rows = [...unique.values()];
        return { ...current, recent_detections: rows, image_records: rows, history_has_more: payload.has_more,
          image_records_truncated: payload.has_more, image_warning: null };
      });
      setImageError('');
    } catch (requestError) { if (requestId === imageRequest.current) setImageError(requestError.message || 'Unable to load image history.'); }
    finally { if (requestId === imageRequest.current) { setLoadingMore(false); imageBusy.current = false; } }
  }, [period]);
  const loadMoreHistory = () => loadImagePage(imageDates.current);
  const filterImageHistory = dates => loadImagePage(dates, true);

  useEffect(() => {
    imageRequest.current += 1; imageBusy.current = false; imageDates.current = {}; imageOffset.current = 0;
    setLoadingMore(false); setImageError("");
    const controller = new AbortController();
    loadDashboard(controller.signal);
    // Historical captures do not need 15-second polling. Refresh on a five-minute
    // cadence only while visible; do not discard filtered/expanded history.
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden' && !imageBusy.current &&
          imageOffset.current <= 5 && !Object.keys(imageDates.current).length) loadDashboard(controller.signal);
    }, 300000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [loadDashboard]);

  const todayLabel = useMemo(() => new Intl.DateTimeFormat("en-IN", { dateStyle: "full" }).format(new Date()), []);



  return (
    <div className="app-shell">
      <Header data={data} todayLabel={todayLabel} />
      <main className="page-content">
        {state === "loading" && !data && <div className="empty-state" role="status">Loading monitoring data… Wind history loads independently below.</div>}
        {state === "error" && (
          <div className="alert error-alert" role="alert">
            <span>{error}</span>
            <button className="text-button" onClick={() => loadDashboard()}>Try again</button>
          </div>
        )}
        {!data && <WindHistory apiBase={API_BASE_URL} timezone="Asia/Kolkata" />}
        {imageError && <div className="alert error-alert" role="alert">{imageError}</div>}
        {data && <Dashboard data={data} period={period} setPeriod={setPeriod} onLoadMore={loadMoreHistory} onImageFilter={filterImageHistory} loadingMore={loadingMore} />}
      </main>
      <footer className="footer">Sickle Innovations Pvt Ltd · Smart Aphid Monitoring · Customer monitoring view</footer>
    </div>
  );
}

function Header({ data, todayLabel }) {
  const status = data?.health?.status;
  const statusLabel = status === "online" ? "Online" : status === "offline" ? "Offline" : "Live connectivity unavailable";
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

function Dashboard({ data, period, setPeriod, onLoadMore, onImageFilter, loadingMore }) {
  const kpis = data.kpis || {};
  const activity = kpis.activity || {};
  const latest = data.latest_detection;
  return (
    <>
      <section className="intro-row">
        <div>
          <p className="eyebrow">Monitoring overview</p>
          <h2>Trap activity at a glance</h2>
          <p className="muted">Available detection records and historical wind operations.</p>
        </div>
        <div className="refresh-note">Updated {formatDate(data.generated_at, data.timezone)}</div>
      </section>

      {data.summary_truncated && <p role="status" className="muted">The summary record limit was reached. Chart and statistics cover only the returned summary records.</p>}
      {data.image_warning && <div className="alert error-alert" role="alert">{data.image_warning}</div>}
      <section className="kpi-grid" aria-label="Monitoring summary">
        <KpiCard label="Aphids detected today" value={kpis.aphids_today} note="Today’s total from processed detections" />
        <KpiCard
          label="Aphid activity"
          value={activity.label || "Not enough data"}
          note={activity.percentage === null ? "Not enough historical data" : `${Math.abs(activity.percentage)}% vs previous ${period === 1 ? "day" : `${period} days`}`}
          tone={activity.direction}
        />
        <KpiCard label="Images analyzed" value={kpis.images_today} note="Processed detections today" />
        <KpiCard label="Last detection" value={data.image_warning ? "Unavailable" : relativeTime(latest?.captured_at)} note={latest ? formatDate(latest.captured_at, data.timezone) : "No detections yet"} compact />
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

      <StickySheet key={data.device_id} deviceId={data.device_id} apiBase={API_BASE_URL} timezone={data.timezone} />

      <section className="history-grid">
        <RecentDetections unavailable={data.image_warning} rows={data.recent_detections || []} timezone={data.timezone} hasMore={data.history_has_more} onLoadMore={onLoadMore} loadingMore={loadingMore} />
        <WindHistory apiBase={API_BASE_URL} timezone={data.timezone} />
      </section>
      <ImageSessions onFilter={onImageFilter} onLoadMore={onLoadMore} loadingMore={loadingMore} rows={data.image_records || data.recent_detections || []} timezone={data.timezone} warning={data.image_warning} truncated={data.image_records_truncated} period={period} />
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
            <div className="count-display"><strong>{detection.insect_count}</strong><span>{detection.insect_count === 1 ? "aphid detected" : "aphids detected"}</span></div>
            <p className="capture-time">{formatDate(detection.captured_at, timezone)}</p>
            <ImageLinks detection={detection} />
          </div>
        </div>
      )}
    </section>
  );
}

function SystemHealth({ health, timezone }) {
  const fields = health?.fields || {};
  const meaning = telemetryDisplay(fields.status, null);
  const direction = DIRECTION_LABELS[normalizeTelemetryCode(fields.wind_direction)] || fields.wind_direction;
  const entries = [
    ["Telemetry status", meaning.label],
    ["Battery", fields.battery_percent == null ? null : `${fields.battery_percent}%`],
    ["Voltage", fields.battery_voltage == null ? null : `${fields.battery_voltage} V`],
    ["Wind direction", direction],
    ["Wind angle", fields.wind_angle == null ? null : `${fields.wind_angle}°`],
  ].filter(([label, value]) => label && value != null && value !== "");
  return (
    <section className="panel health-panel">
      <div className="panel-heading"><div><p className="eyebrow">Device telemetry</p><h3>System health</h3></div></div>
      {!health?.available ? <EmptyState message="Telemetry unavailable." /> : (
        <>
          <div className="health-status">Historical operation snapshot — connectivity unknown</div>
          <div className="health-list">
            <HealthRow label="Last operation (IST)" value={formatDate(health.last_operation, timezone)} />
            <p className="muted">{health.note}</p>
            {entries.map(([label, value]) => <HealthRow key={label} label={label} value={value} />)}
          </div>
        </>
      )}
    </section>
  );
}

function HealthRow({ label, value }) { return <div className="health-row"><span>{label}</span><strong>{value}</strong></div>; }

function RecentDetections({ unavailable, rows, timezone, hasMore, onLoadMore, loadingMore }) {
  return (
    <section className="panel recent-panel">
      <div className="panel-heading"><div><p className="eyebrow">History</p><h3>Image History</h3></div></div>
      {unavailable ? <EmptyState message="Image history unavailable. See the data-source notice above." /> : !rows.length ? <EmptyState message="No detections recorded yet." /> : (
        <>
          <div className="recent-list">
            {rows.map((row, index) => (
              <div className="recent-row" key={`${row.captured_at}-${index}`}>
                <ImageFrame detection={row} />
                <div className="recent-time"><strong>{formatDate(row.captured_at, timezone)}</strong><span>{relativeTime(row.captured_at)}</span></div>
                <div className="recent-count"><strong>{row.insect_count}</strong><span>{row.insect_count === 1 ? "aphid" : "aphids"}</span></div>

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
