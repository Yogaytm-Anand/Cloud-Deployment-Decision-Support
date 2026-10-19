import { useEffect, useState } from "react";
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from "recharts";
import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { fetchMetrics } from "../services/api";

const POLL_INTERVAL_MS = 5000;
const HISTORY_LIMIT = 48;

function formatValue(value, unit, precision = 1) {
    return value == null ? "—" : `${Number(value).toFixed(precision)} ${unit}`;
}

function ChartTooltip({ active, payload, label, unit }) {
    if (!active || !payload?.length) return null;

    return (
        <div className="chart-tooltip">
            <span>{label}</span>
            <strong>{formatValue(payload[0].value, unit, 2)}</strong>
        </div>
    );
}

function TrendChart({ data, dataKey, color, unit }) {
    return (
        <div className="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
                    <defs>
                        <linearGradient id={`fill-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.34} />
                            <stop offset="100%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e7e1d7" strokeDasharray="3 5" vertical={false} />
                    <XAxis dataKey="time" hide />
                    <YAxis hide domain={["auto", "auto"]} />
                    <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: "#b9aa93", strokeDasharray: "3 3" }} />
                    <Area
                        type="monotone"
                        dataKey={dataKey}
                        stroke={color}
                        strokeWidth={2.5}
                        fill={`url(#fill-${dataKey})`}
                        connectNulls
                        isAnimationActive={false}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}

function StatCard({ label, value, detail, tone = "gold" }) {
    return (
        <article className={`stat-card stat-card--${tone}`}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
        </article>
    );
}

function Monitoring() {
    const navigate = useNavigate();
    const { analysis, metrics, setMetrics } = useApp();
    const jobId = analysis?.jobId ?? null;
    const [metricsError, setMetricsError] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [history, setHistory] = useState([]);

    useEffect(() => {
        if (!jobId) return undefined;

        let isSubscribed = true;
        setHistory([]);

        const loadMetrics = async () => {
            try {
                const data = await fetchMetrics(jobId);
                if (!isSubscribed) return;

                const capturedAt = new Date();
                setMetrics(data);
                setMetricsError(null);
                setLastUpdated(capturedAt);
                setHistory((samples) => [
                    ...samples,
                    {
                        time: capturedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
                        cpu: data.cpu == null ? null : Number((data.cpu * 1000).toFixed(3)),
                        memory: data.memoryMiB ?? null,
                        latency: data.responseTimeMs ?? null,
                        errorRate: data.errorRate ?? null
                    }
                ].slice(-HISTORY_LIMIT));
            } catch (error) {
                if (isSubscribed) setMetricsError(error.message);
            }
        };

        loadMetrics();
        const interval = setInterval(loadMetrics, POLL_INTERVAL_MS);

        return () => {
            isSubscribed = false;
            clearInterval(interval);
        };
    }, [jobId, setMetrics]);

    const cpuMillicores = metrics?.cpu == null ? null : metrics.cpu * 1000;
    const memoryMiB = metrics?.memoryMiB ?? null;
    const status = metricsError ? "Degraded" : metrics?.pod ? "Healthy" : "Waiting for data";

    return (
        <main className="monitoring-page app-shell">
            <header className="monitoring-hero">
                <div className="brand-lockup">
                    <span className="brand-mark">CD</span>
                    <div>
                        <p className="eyebrow">Cloud Deployment Decision Support</p>
                        <h1>Runtime observability</h1>
                    </div>
                </div>
                <div className="hero-actions">
                    <div className={`live-status ${metricsError ? "live-status--alert" : ""}`}><i /> {status}</div>
                    <button className="quiet-button" onClick={() => navigate("/analysis")}>Deployment details</button>
                </div>
            </header>

            {!jobId ? (
                <section className="empty-state modern-empty-state">
                    <p>No deployment is selected yet.</p>
                    <button className="primary-button" onClick={() => navigate("/")}>Submit a repository</button>
                </section>
            ) : (
                <>
                    <section className="deployment-strip">
                        <div><span>Watching deployment</span><strong>{jobId}</strong></div>
                        <div><span>Active pod</span><strong>{metrics?.pod ?? "Discovering pod…"}</strong></div>
                        <div><span>Refresh cadence</span><strong>Every {POLL_INTERVAL_MS / 1000} seconds</strong></div>
                    </section>

                    {metricsError && <div className="error-banner">Prometheus is temporarily unavailable: {metricsError}</div>}

                    <section className="stats-grid" aria-label="Current metrics">
                        <StatCard label="CPU usage" value={formatValue(cpuMillicores, "m", 2)} detail={metrics?.cpuPercentage == null ? "Awaiting resource data" : `${metrics.cpuPercentage.toFixed(1)}% of limit`} tone="gold" />
                        <StatCard label="Memory" value={formatValue(memoryMiB, "MiB", 2)} detail={metrics?.memoryPercentage == null ? "Awaiting resource data" : `${metrics.memoryPercentage.toFixed(1)}% of limit`} tone="blue" />
                        <StatCard label="Response time" value={formatValue(metrics?.responseTimeMs, "ms", 0)} detail="Latest service probe" tone="green" />
                        <StatCard label="Error rate" value={formatValue(metrics?.errorRate, "%", 1)} detail="Rolling probe history" tone={metrics?.errorRate > 5 ? "rose" : "green"} />
                    </section>

                    <section className="charts-grid" aria-label="Real-time metric charts">
                        <article className="chart-card chart-card--wide">
                            <div className="chart-card__header"><div><span className="eyebrow">Live series</span><h2>CPU consumption</h2></div><strong>{formatValue(cpuMillicores, "m", 2)}</strong></div>
                            <TrendChart data={history} dataKey="cpu" color="#b88948" unit="m" />
                            <p>Rolling samples from Prometheus</p>
                        </article>
                        <article className="chart-card chart-card--wide">
                            <div className="chart-card__header"><div><span className="eyebrow">Live series</span><h2>Memory footprint</h2></div><strong>{formatValue(memoryMiB, "MiB", 2)}</strong></div>
                            <TrendChart data={history} dataKey="memory" color="#496f91" unit="MiB" />
                            <p>Working-set memory from Prometheus</p>
                        </article>
                        <article className="chart-card">
                            <div className="chart-card__header"><div><span className="eyebrow">Service health</span><h2>Response time</h2></div><strong>{formatValue(metrics?.responseTimeMs, "ms", 0)}</strong></div>
                            <TrendChart data={history} dataKey="latency" color="#548270" unit="ms" />
                        </article>
                        <article className="chart-card">
                            <div className="chart-card__header"><div><span className="eyebrow">Reliability</span><h2>Probe error rate</h2></div><strong>{formatValue(metrics?.errorRate, "%", 1)}</strong></div>
                            <TrendChart data={history} dataKey="errorRate" color="#bd5d55" unit="%" />
                        </article>
                    </section>

                    <p className="last-updated">{lastUpdated ? `Last sample ${lastUpdated.toLocaleTimeString()} · retaining the latest ${HISTORY_LIMIT} samples` : "Connecting to Prometheus…"}</p>
                </>
            )}
        </main>
    );
}

export default Monitoring;
