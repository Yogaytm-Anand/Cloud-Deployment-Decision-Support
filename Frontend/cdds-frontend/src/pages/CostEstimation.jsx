import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { fetchMetrics, fetchLoadTests } from "../services/api";
import "../cost-estimation.css";

const DEFAULTS = {
    replicas: 1,
    cpuRequestMillicores: 100,
    memoryRequestMiB: 128,
    instanceType: "auto",
    supportTier: "standard",
    storageGiBPerNode: 20
};

const INSTANCE_OPTIONS = [
    { value: "auto", label: "Auto — smallest suitable instance" },
    { value: "t3.micro", label: "t3.micro — 2 vCPU / 1 GiB" },
    { value: "t3.small", label: "t3.small — 2 vCPU / 2 GiB" },
    { value: "t3.medium", label: "t3.medium — 2 vCPU / 4 GiB" },
    { value: "t3.large", label: "t3.large — 2 vCPU / 8 GiB" },
    { value: "t3.xlarge", label: "t3.xlarge — 4 vCPU / 16 GiB" }
];

const money = (value) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 2
}).format(value ?? 0);

function formatValue(value, unit, precision = 1) {
    return value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(precision)} ${unit}`;
}

function CostEstimation() {
    const navigate = useNavigate();
    const { analysis, metrics, loadTests, setMetrics, saveLoadTest } = useApp();
    const [form, setForm] = useState(DEFAULTS);
    const [estimate, setEstimate] = useState(null);
    const [loading, setLoading] = useState(false);
    const [telemetryLoading, setTelemetryLoading] = useState(false);
    const [appliedNotice, setAppliedNotice] = useState(null);
    const [error, setError] = useState("");

    const currentJobLoadTests = useMemo(
        () => (loadTests || []).filter((test) => test.jobId === analysis?.jobId),
        [loadTests, analysis?.jobId]
    );
    const latestLoadTest = currentJobLoadTests[currentJobLoadTests.length - 1] || null;

    const liveCpuMillicores = metrics?.cpu != null ? metrics.cpu * 1000 : null;
    const liveMemoryMiB = metrics?.memoryMiB ?? null;

    const peakLoadCpu = latestLoadTest?.resources?.cpuCoresPeak != null
        ? latestLoadTest.resources.cpuCoresPeak * 1000
        : (latestLoadTest?.cpuCoresPeak != null ? latestLoadTest.cpuCoresPeak * 1000 : null);
    const peakLoadMemory = latestLoadTest?.resources?.memoryBytesPeak != null
        ? latestLoadTest.resources.memoryBytesPeak / 1024 / 1024
        : (latestLoadTest?.memoryBytesPeak != null ? latestLoadTest.memoryBytesPeak / 1024 / 1024 : null);

    // Sync metrics and load test history on mount when a deployment is active
    useEffect(() => {
        if (!analysis?.jobId) return;
        let isSubscribed = true;

        const syncTelemetry = async () => {
            setTelemetryLoading(true);
            try {
                const promises = [];
                if (!metrics) {
                    promises.push(
                        fetchMetrics(analysis.jobId)
                            .then((data) => { if (isSubscribed) setMetrics(data); })
                            .catch(() => {})
                    );
                }
                promises.push(
                    fetchLoadTests(analysis.jobId)
                        .then((data) => {
                            if (isSubscribed && data.success && Array.isArray(data.history)) {
                                data.history.forEach((test) => saveLoadTest(test));
                            }
                        })
                        .catch(() => {})
                );
                await Promise.allSettled(promises);
            } finally {
                if (isSubscribed) setTelemetryLoading(false);
            }
        };

        syncTelemetry();
        return () => { isSubscribed = false; };
    }, [analysis?.jobId, metrics, saveLoadTest, setMetrics]);

    const refreshTelemetry = async () => {
        if (!analysis?.jobId) return;
        setTelemetryLoading(true);
        try {
            const [mResult, ltResult] = await Promise.allSettled([
                fetchMetrics(analysis.jobId),
                fetchLoadTests(analysis.jobId)
            ]);
            if (mResult.status === "fulfilled") setMetrics(mResult.value);
            if (ltResult.status === "fulfilled" && ltResult.value.success && Array.isArray(ltResult.value.history)) {
                ltResult.value.history.forEach((test) => saveLoadTest(test));
            }
        } finally {
            setTelemetryLoading(false);
        }
    };

    const update = (event) => {
        const { name, value } = event.target;
        setForm((previous) => ({
            ...previous,
            [name]: ["instanceType", "supportTier"].includes(name) ? value : Number(value)
        }));
    };

    const calculate = async (event) => {
        event.preventDefault();
        setLoading(true);
        setError("");
        setEstimate(null);
        try {
            const response = await fetch("/api/cost-estimate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...form,
                    jobId: analysis?.jobId,
                    loadTests: currentJobLoadTests
                })
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.message || "Could not calculate the estimate.");
            }
            setEstimate(data.estimate);
        } catch (err) {
            setError(err.message || "Could not connect to the backend.");
        } finally {
            setLoading(false);
        }
    };

    const applyLoadTestPeaks = () => {
        if (peakLoadCpu == null && peakLoadMemory == null) return;
        const suggestedCpu = peakLoadCpu != null ? Math.max(1, Math.ceil(peakLoadCpu * 1.3)) : form.cpuRequestMillicores;
        const suggestedMemory = peakLoadMemory != null ? Math.max(1, Math.ceil(peakLoadMemory * 1.3)) : form.memoryRequestMiB;
        setForm((previous) => ({
            ...previous,
            cpuRequestMillicores: suggestedCpu,
            memoryRequestMiB: suggestedMemory
        }));
        setAppliedNotice(`Applied load-test peaks with 30% headroom (${suggestedCpu}m CPU / ${suggestedMemory} MiB Memory).`);
    };

    const applyLiveMonitoring = () => {
        if (liveCpuMillicores == null && liveMemoryMiB == null) return;
        const suggestedCpu = liveCpuMillicores != null ? Math.max(1, Math.ceil(liveCpuMillicores * 1.3)) : form.cpuRequestMillicores;
        const suggestedMemory = liveMemoryMiB != null ? Math.max(1, Math.ceil(liveMemoryMiB * 1.3)) : form.memoryRequestMiB;
        setForm((previous) => ({
            ...previous,
            cpuRequestMillicores: suggestedCpu,
            memoryRequestMiB: suggestedMemory
        }));
        setAppliedNotice(`Applied live monitoring baseline with 30% headroom (${suggestedCpu}m CPU / ${suggestedMemory} MiB Memory).`);
    };

    const useDeploymentDefaults = () => {
        setForm((previous) => ({
            ...DEFAULTS,
            instanceType: previous.instanceType,
            supportTier: previous.supportTier,
            storageGiBPerNode: previous.storageGiBPerNode
        }));
        setAppliedNotice("Reset to standard Kubernetes deployment configuration defaults (100m CPU / 128 MiB Memory).");
        setEstimate(null);
        setError("");
    };

    return (
        <main className="cost-page">
            <header className="cost-header">
                <div>
                    <p className="cost-eyebrow">CLOUD PLANNING / AWS</p>
                    <h1>Cost estimation</h1>
                    <p>Estimate EKS + EC2 worker-node costs from the selected deployment’s configuration, runtime metrics and completed load tests.</p>
                </div>
                <span className="cost-region-badge">us-east-1 · USD</span>
            </header>

            {analysis?.jobId && (
                <div className="cost-context">
                    <div>
                        <strong>Current local deployment selected</strong>
                        <p>{analysis.repository} · {analysis.jobId}</p>
                    </div>
                    <button type="button" className="cost-secondary-button" onClick={useDeploymentDefaults}>
                        Reset to Kubernetes spec
                    </button>
                </div>
            )}

            {analysis?.jobId && (
                <section className="cost-telemetry-panel" aria-label="Pulled telemetry data">
                    <div className="cost-telemetry-header">
                        <div>
                            <h2>Data pulled from Monitoring & Load Testing</h2>
                            <p>Real-time metrics from the Observability dashboard and k6 load tests are pulled to inform realistic cloud capacity sizing.</p>
                        </div>
                        <button
                            type="button"
                            className="cost-secondary-button"
                            onClick={refreshTelemetry}
                            disabled={telemetryLoading}
                        >
                            {telemetryLoading ? "Refreshing…" : "↻ Refresh telemetry"}
                        </button>
                    </div>

                    {appliedNotice && (
                        <div className="cost-applied-badge">
                            ✓ {appliedNotice}
                        </div>
                    )}

                    <div className="cost-telemetry-grid">
                        {/* Monitoring Dashboard Card */}
                        <div className="cost-telemetry-card">
                            <div>
                                <div className="cost-telemetry-card-head">
                                    <strong>Prometheus Observability</strong>
                                    <span className={`cost-telemetry-badge ${metrics?.pod ? "cost-telemetry-badge--active" : "cost-telemetry-badge--empty"}`}>
                                        {metrics?.pod ? "Live" : "No live pod"}
                                    </span>
                                </div>
                                <div className="cost-telemetry-stats">
                                    <div className="cost-telemetry-row">
                                        <span>Active pod</span>
                                        <strong>{metrics?.pod || "Awaiting discovery"}</strong>
                                    </div>
                                    <div className="cost-telemetry-row">
                                        <span>Live CPU usage</span>
                                        <strong>{formatValue(liveCpuMillicores, "m", 2)} {metrics?.cpuPercentage != null ? `(${metrics.cpuPercentage.toFixed(1)}%)` : ""}</strong>
                                    </div>
                                    <div className="cost-telemetry-row">
                                        <span>Live memory footprint</span>
                                        <strong>{formatValue(liveMemoryMiB, "MiB", 2)} {metrics?.memoryPercentage != null ? `(${metrics.memoryPercentage.toFixed(1)}%)` : ""}</strong>
                                    </div>
                                    <div className="cost-telemetry-row">
                                        <span>Probe latency / error</span>
                                        <strong>{formatValue(metrics?.responseTimeMs, "ms", 0)} / {formatValue(metrics?.errorRate, "%", 1)}</strong>
                                    </div>
                                </div>
                            </div>
                            <div className="cost-telemetry-actions">
                                <button
                                    type="button"
                                    className="cost-telemetry-btn cost-telemetry-btn--primary"
                                    onClick={applyLiveMonitoring}
                                    disabled={liveCpuMillicores == null && liveMemoryMiB == null}
                                >
                                    Apply live baseline (+30%)
                                </button>
                                <button
                                    type="button"
                                    className="cost-telemetry-btn"
                                    onClick={() => navigate("/monitoring")}
                                >
                                    View dashboard ↗
                                </button>
                            </div>
                        </div>

                        {/* Load Testing Card */}
                        <div className="cost-telemetry-card">
                            <div>
                                <div className="cost-telemetry-card-head">
                                    <strong>k6 Load Testing</strong>
                                    <span className={`cost-telemetry-badge ${latestLoadTest ? "cost-telemetry-badge--load" : "cost-telemetry-badge--empty"}`}>
                                        {latestLoadTest ? "Measured" : "No test run"}
                                    </span>
                                </div>
                                <div className="cost-telemetry-stats">
                                    <div className="cost-telemetry-row">
                                        <span>Latest workload test</span>
                                        <strong>
                                            {latestLoadTest
                                                ? `${latestLoadTest.loadTest?.level || "Custom"} (${latestLoadTest.loadTest?.vus ?? "—"} VUs · ${latestLoadTest.loadTest?.duration ?? "—"})`
                                                : "None"}
                                        </strong>
                                    </div>
                                    <div className="cost-telemetry-row">
                                        <span>Peak CPU under load</span>
                                        <strong>{formatValue(peakLoadCpu, "m", 2)}</strong>
                                    </div>
                                    <div className="cost-telemetry-row">
                                        <span>Peak memory under load</span>
                                        <strong>{formatValue(peakLoadMemory, "MiB", 2)}</strong>
                                    </div>
                                    <div className="cost-telemetry-row">
                                        <span>Throughput & p95 latency</span>
                                        <strong>
                                            {formatValue(latestLoadTest?.loadTest?.requestsPerSecond, " req/s")} / {formatValue(latestLoadTest?.loadTest?.p95ResponseTimeMs, "ms")}
                                        </strong>
                                    </div>
                                </div>
                            </div>
                            <div className="cost-telemetry-actions">
                                <button
                                    type="button"
                                    className="cost-telemetry-btn cost-telemetry-btn--primary"
                                    onClick={applyLoadTestPeaks}
                                    disabled={peakLoadCpu == null && peakLoadMemory == null}
                                >
                                    Apply load peaks (+30%)
                                </button>
                                <button
                                    type="button"
                                    className="cost-telemetry-btn"
                                    onClick={() => navigate("/load-testing")}
                                >
                                    Run load test ↗
                                </button>
                            </div>
                        </div>
                    </div>
                </section>
            )}

            <div className="cost-layout">
                <form className="cost-panel cost-form" onSubmit={calculate}>
                    <div className="cost-section-heading">
                        <span className="cost-step">01</span>
                        <div><h2>Workload configuration</h2><p>Configure pod replicas and request allocations or populate directly from observed telemetry above.</p></div>
                    </div>

                    <label>
                        Pod replicas
                        <input name="replicas" type="number" min="1" max="1000" step="1" value={form.replicas} onChange={update} required />
                    </label>
                    <div className="cost-two-column">
                        <label>
                            CPU request per pod (millicores)
                            <input name="cpuRequestMillicores" type="number" min="1" max="64000" value={form.cpuRequestMillicores} onChange={update} required />
                            <small>100m = 0.1 vCPU</small>
                        </label>
                        <label>
                            Memory request per pod (MiB)
                            <input name="memoryRequestMiB" type="number" min="1" max="1048576" value={form.memoryRequestMiB} onChange={update} required />
                            <small>128 MiB is the current generated default</small>
                        </label>
                    </div>

                    <div className="cost-section-heading cost-section-heading--second">
                        <span className="cost-step">02</span>
                        <div><h2>AWS pricing assumptions</h2><p>Linux On-Demand reference rates.</p></div>
                    </div>

                    <label>
                        EC2 instance type
                        <select name="instanceType" value={form.instanceType} onChange={update}>
                            {INSTANCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                    </label>
                    <label>
                        EKS Kubernetes support tier
                        <select name="supportTier" value={form.supportTier} onChange={update}>
                            <option value="standard">Standard support — $0.10 per cluster/hour</option>
                            <option value="extended">Extended support — $0.60 per cluster/hour</option>
                        </select>
                    </label>
                    <label>
                        EBS gp3 storage per worker node (GiB)
                        <input name="storageGiBPerNode" type="number" min="0" max="16384" value={form.storageGiBPerNode} onChange={update} required />
                    </label>

                    <button className="cost-primary-button" type="submit" disabled={loading}>
                        {loading ? "Calculating…" : "Calculate estimated cost"}
                    </button>
                    {error && <p className="cost-error" role="alert">{error}</p>}
                </form>

                <section className="cost-results-column">
                    {!estimate ? (
                        <div className="cost-panel cost-empty">
                            <div className="cost-empty-icon">＄</div>
                            <h2>Your estimate will appear here</h2>
                            <p>Submit the workload and pricing assumptions to see the estimated node count, hourly rate and monthly cost breakdown.</p>
                            <ul>
                                <li>No AWS account connection required</li>
                                <li>No cloud resources are created</li>
                                <li>Uses a documented reference-rate model</li>
                            </ul>
                        </div>
                    ) : (
                        <>
                            <div className="cost-total-card">
                                <p className="cost-eyebrow">ESTIMATED MONTHLY TOTAL</p>
                                <strong>{money(estimate.totalMonthly)}</strong>
                                <span>{money(estimate.totalHourly)} per hour · {money(estimate.totalYearly)} per year</span>
                                <div className="cost-total-meta">
                                    <span>{estimate.recommendedNodes} recommended worker node{estimate.recommendedNodes === 1 ? "" : "s"}</span>
                                    <span>{estimate.estimatedPodsPerNode} estimated pod slots per node</span>
                                </div>
                            </div>

                            <div className="cost-panel">
                                <div className="cost-section-heading">
                                    <span className="cost-step">03</span>
                                    <div><h2>Monthly cost breakdown</h2><p>{estimate.instanceType} · {estimate.region}</p></div>
                                </div>
                                <div className="cost-breakdown-row">
                                    <div><strong>EC2 worker nodes</strong><small>{estimate.recommendedNodes} × {money(estimate.rates.ec2HourlyPerNode)}/hour × 730 hours</small></div>
                                    <strong>{money(estimate.breakdown.ec2Monthly)}</strong>
                                </div>
                                <div className="cost-breakdown-row">
                                    <div><strong>EKS cluster control plane</strong><small>{money(estimate.rates.eksHourly)}/hour × 730 hours</small></div>
                                    <strong>{money(estimate.breakdown.eksClusterMonthly)}</strong>
                                </div>
                                <div className="cost-breakdown-row">
                                    <div><strong>EBS gp3 storage</strong><small>{estimate.recommendedNodes} nodes × {form.storageGiBPerNode} GiB</small></div>
                                    <strong>{money(estimate.breakdown.storageMonthly)}</strong>
                                </div>
                                <div className="cost-breakdown-total"><span>Estimated monthly total</span><strong>{money(estimate.totalMonthly)}</strong></div>
                            </div>

                            <div className="cost-panel cost-assumptions">
                                <h2>Measurement status & telemetry impact</h2>
                                <p className="cost-warning">{estimate.inputs.runtimeMeasurements.status === "measured" ? "Live Prometheus measurements and completed load-test peaks informed capacity sizing; Kubernetes requests remain visible separately." : "No runtime measurements were used. This is a Kubernetes-configuration fallback estimate."}</p>

                                {estimate.inputs.runtimeMeasurements.status === "measured" && (
                                    <div className="cost-telemetry-stats" style={{ margin: "14px 0", padding: "12px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                                        <div className="cost-telemetry-row">
                                            <span>Configured CPU request</span>
                                            <strong>{formatValue(estimate.cpuRequestMillicores, "m", 1)}</strong>
                                        </div>
                                        <div className="cost-telemetry-row">
                                            <span>Observed peak workload CPU</span>
                                            <strong>{formatValue(estimate.inputs.runtimeMeasurements.cpuMillicoresTotal, "m", 2)}</strong>
                                        </div>
                                        <div className="cost-telemetry-row">
                                            <span>Sized CPU capacity demand (per pod)</span>
                                            <strong>{formatValue(estimate.capacityCpuMillicores, "m", 1)}</strong>
                                        </div>
                                        <div className="cost-telemetry-row" style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px dashed #cbd5e1" }}>
                                            <span>Configured memory request</span>
                                            <strong>{formatValue(estimate.memoryRequestMiB, "MiB", 1)}</strong>
                                        </div>
                                        <div className="cost-telemetry-row">
                                            <span>Observed peak workload memory</span>
                                            <strong>{formatValue(estimate.inputs.runtimeMeasurements.memoryMiBTotal, "MiB", 2)}</strong>
                                        </div>
                                        <div className="cost-telemetry-row">
                                            <span>Sized memory capacity demand (per pod)</span>
                                            <strong>{formatValue(estimate.capacityMemoryMiB, "MiB", 1)}</strong>
                                        </div>
                                    </div>
                                )}

                                {estimate.inputs.loadTests.length > 0 && <p className="cost-warning">{estimate.inputs.loadTests.length} completed load test{estimate.inputs.loadTests.length === 1 ? "" : "s"} retained for this deployment.</p>}
                                {estimate.inputs.warnings.map((warning) => <p className="cost-warning" key={warning}>{warning}</p>)}
                                <h2>Assumptions and exclusions</h2>
                                <ul>{estimate.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
                                <p className="cost-warning">This is a planning estimate, not a quote or actual AWS bill. Verify rates for your target region and architecture before making a deployment decision.</p>
                                <div className="cost-source-links">
                                    <a href={estimate.pricingSources.eks} target="_blank" rel="noreferrer">EKS pricing ↗</a>
                                    <a href={estimate.pricingSources.ec2} target="_blank" rel="noreferrer">EC2 T3 pricing ↗</a>
                                    <a href={estimate.pricingSources.priceCalculator} target="_blank" rel="noreferrer">AWS Pricing Calculator ↗</a>
                                </div>
                            </div>
                        </>
                    )}
                </section>
            </div>
            <p className="cost-footnote">Kubernetes requests and limits are configuration; CPU and memory observations are measurements. The estimator keeps them separate and applies a 20% node reserve plus 30% headroom to observed per-pod use when it exists.</p>
        </main>
    );
}

export default CostEstimation;
