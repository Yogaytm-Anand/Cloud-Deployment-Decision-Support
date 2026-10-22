import { useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApp } from "../context/AppContext";
import { runLoadTest } from "../services/api";

const PRESETS = {
    light: { vus: 10, duration: "20s" },
    medium: { vus: 50, duration: "30s" },
    heavy: { vus: 100, duration: "30s" }
};

const number = (value, suffix = "", digits = 2) => Number.isFinite(value) ? `${Number(value).toFixed(digits)}${suffix}` : "—";

function LoadTesting() {
    const { analysis, loadTests, saveLoadTest } = useApp();
    const [form, setForm] = useState({ loadLevel: "light", targetPath: "/", ...PRESETS.light });
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const currentResult = useMemo(() => loadTests.filter((test) => test.jobId === analysis?.jobId).at(-1) || null, [analysis?.jobId, loadTests]);

    const selectLevel = (event) => {
        const loadLevel = event.target.value;
        setForm((previous) => ({ ...previous, loadLevel, ...(PRESETS[loadLevel] || {}) }));
    };

    const start = async (event) => {
        event.preventDefault();
        if (!analysis?.jobId || running) return;
        setRunning(true);
        setError("");
        try {
            const result = await runLoadTest({ jobId: analysis.jobId, ...form });
            saveLoadTest({ ...result, completedAt: new Date().toISOString() });
        } catch (requestError) {
            setError(requestError.message || "The load test could not be started.");
        } finally {
            setRunning(false);
        }
    };

    const resourceData = currentResult?.resources?.available ? [
        { name: "Average", cpu: currentResult.resources.cpuCoresAverage * 1000, memory: currentResult.resources.memoryBytesAverage / 1024 / 1024 },
        { name: "Peak", cpu: currentResult.resources.cpuCoresPeak * 1000, memory: currentResult.resources.memoryBytesPeak / 1024 / 1024 }
    ] : [];
    const load = currentResult?.loadTest;

    return (
        <main className="load-test-page app-shell">
            <header className="monitoring-hero">
                <div className="brand-lockup"><span className="brand-mark">CD</span><div><p className="eyebrow">Measured workload / k6</p><h1>Load testing</h1></div></div>
                <div className={`live-status ${running ? "" : "live-status--quiet"}`}><i /> {running ? "Test running" : "Ready"}</div>
            </header>

            {!analysis?.jobId ? <section className="empty-state modern-empty-state"><p>Deploy a repository before starting a load test.</p></section> : <>
                <section className="load-test-layout">
                    <form className="load-test-form" onSubmit={start}>
                        <span className="eyebrow">Target deployment</span>
                        <strong>{analysis.jobId}</strong>
                        <label>Load level<select value={form.loadLevel} onChange={selectLevel} disabled={running}><option value="light">Light — 10 virtual users / 20 seconds</option><option value="medium">Medium — 50 virtual users / 30 seconds</option><option value="heavy">Heavy — 100 virtual users / 30 seconds</option><option value="custom">Custom</option></select></label>
                        <div className="load-test-inputs">
                            <label>Virtual users<input type="number" min="1" max="100" value={form.vus} disabled={running || form.loadLevel !== "custom"} onChange={(event) => setForm((previous) => ({ ...previous, vus: Number(event.target.value) }))} /></label>
                            <label>Duration<input value={form.duration} disabled={running || form.loadLevel !== "custom"} onChange={(event) => setForm((previous) => ({ ...previous, duration: event.target.value }))} /></label>
                        </div>
                        <label>Application path<input value={form.targetPath} maxLength="200" placeholder="/" disabled={running} onChange={(event) => setForm((previous) => ({ ...previous, targetPath: event.target.value }))} /></label>
                        <small>Uses the deployment’s Kubernetes Service; only a local path is allowed.</small>
                        <button className="primary-button" disabled={running}>{running ? "Running test…" : "Start test"}</button>
                        {error && <p className="error-banner" role="alert">{error}</p>}
                    </form>

                    <section className="load-test-results">
                        {!load ? <div className="load-test-empty"><h2>No result yet</h2><p>Completed results remain available in this session and are used by Cost Estimation for the selected deployment.</p></div> : <>
                            <div className="load-test-result-heading"><div><span className="eyebrow">Measured result</span><h2>{load.level} test · {load.vus} VUs · {load.duration}</h2></div><small>{new Date(currentResult.completedAt).toLocaleString()}</small></div>
                            <div className="load-test-metrics">
                                <article><span>Total requests</span><strong>{number(load.totalRequests, "", 0)}</strong></article>
                                <article><span>Throughput</span><strong>{number(load.requestsPerSecond, " req/s")}</strong></article>
                                <article><span>Average latency</span><strong>{number(load.averageResponseTimeMs, " ms")}</strong></article>
                                <article><span>p95 latency</span><strong>{number(load.p95ResponseTimeMs, " ms")}</strong></article>
                                <article><span>Maximum latency</span><strong>{number(load.maxResponseTimeMs, " ms")}</strong></article>
                                <article><span>Failed requests</span><strong>{number(load.totalRequests * load.failedRequestPercentage / 100, "", 0)}</strong><small>{number(load.failedRequestPercentage, "%")}</small></article>
                            </div>
                            {resourceData.length ? <article className="load-resource-chart"><h2>Resource behavior during test</h2><ResponsiveContainer width="100%" height={190}><AreaChart data={resourceData}><XAxis dataKey="name" /><YAxis yAxisId="cpu" /><YAxis yAxisId="memory" orientation="right" /><Tooltip /><Area yAxisId="cpu" type="monotone" dataKey="cpu" name="CPU (m)" stroke="#b88948" fill="#ead8b7" /><Area yAxisId="memory" type="monotone" dataKey="memory" name="Memory (MiB)" stroke="#496f91" fill="#c8d9e7" /></AreaChart></ResponsiveContainer></article> : <p className="load-test-note">Resource samples were unavailable: {currentResult.resources?.error || currentResult.resources?.warning || "Prometheus did not return data during this test."}</p>}
                        </>}
                    </section>
                </section>
            </>}
        </main>
    );
}

export default LoadTesting;
