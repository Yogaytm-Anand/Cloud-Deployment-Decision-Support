import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { fetchMetrics, fetchStoredCostEstimate, fetchStoredReport, generateReport } from "../services/api";

function stageStatus(attempted, success) {
    if (!attempted) return { label: "Not run", tone: "muted" };
    return success ? { label: "Passed", tone: "success" } : { label: "Needs attention", tone: "danger" };
}

function formatMetric(value, unit, digits = 0) {
    return value == null ? "Not available" : `${Number(value).toFixed(digits)} ${unit}`;
}

function Report() {
    const navigate = useNavigate();
    const { analysis, metrics, loadTests, costEstimate, setMetrics, saveCostEstimate } = useApp();
    const [aiResult, setAiResult] = useState(null);
    const [aiError, setAiError] = useState("");
    const [generating, setGenerating] = useState(false);
    const jobId = analysis?.jobId;
    const currentLoadTests = useMemo(() => (loadTests || []).filter((item) => item.jobId === jobId), [loadTests, jobId]);
    useEffect(() => {
        if (!jobId) return undefined;
        let active = true;
        fetchStoredReport(jobId).then((data) => {
            if (active && data.report) setAiResult(data.report);
        }).catch(() => {});
        if (!metrics) {
            fetchMetrics(jobId).then((data) => {
                if (active) setMetrics(data);
            }).catch(() => {});
        }
        if (!costEstimate || costEstimate.jobId !== jobId) {
            fetchStoredCostEstimate(jobId).then((data) => {
                if (active && data.estimate) saveCostEstimate(data.estimate);
            }).catch(() => {});
        }
        return () => { active = false; };
    }, [jobId, metrics, costEstimate, saveCostEstimate, setMetrics]);

    if (!analysis) {
        return (
            <main className="report-page report-document">
                <section className="report-empty">
                    <p className="eyebrow">Deployment brief</p>
                    <h1>No deployment report yet.</h1>
                    <p>Run a deployment to create a concise record of its readiness, resources, and follow-up actions.</p>
                    <button className="primary-button" onClick={() => navigate("/")}>Start a deployment</button>
                </section>
            </main>
        );
    }

    const { repository, validation, dockerBuild, kubernetesGeneration, kubernetesDeployment } = analysis;
    const prerequisites = {
        cpuMemory: Number.isFinite(Number(metrics?.cpu)) && Number.isFinite(Number(metrics?.memoryMiB)),
        loadTesting: currentLoadTests.length > 0,
        costEstimation: Boolean(costEstimate?.jobId === jobId && costEstimate?.estimate)
    };
    const loadChartRuns = currentLoadTests.filter((item) => item.loadTest).slice(-8);
    const maxThroughput = Math.max(...loadChartRuns.map((item) => Number(item.loadTest.requestsPerSecond) || 0), 1);
    const maxP95 = Math.max(...loadChartRuns.map((item) => Number(item.loadTest.p95ResponseTimeMs) || 0), 1);
    const latestLoadTestAt = currentLoadTests.reduce((latest, item) => Math.max(latest, Date.parse(item.completedAt || 0) || 0), 0);
    const reportIsOutdated = Boolean(aiResult && ((Date.parse(costEstimate?.calculatedAt || 0) || 0) > (Date.parse(aiResult.generatedAt || 0) || 0) || latestLoadTestAt > (Date.parse(aiResult.generatedAt || 0) || 0)));
    const createAiReport = async () => {
        setGenerating(true);
        setAiError("");
        try {
            const result = await generateReport({ jobId, metrics, loadTests: currentLoadTests, costEstimate });
            setAiResult(result);
        } catch (error) {
            setAiError(error.message || "The report could not be generated.");
        } finally {
            setGenerating(false);
        }
    };
    const repoName = repository.replace("https://github.com/", "");
    const stages = [
        { title: "Repository validation", detail: validation.dockerfile ? "Dockerfile found in the repository root." : "No Dockerfile was found in the repository root.", status: validation.dockerfile ? { label: "Passed", tone: "success" } : { label: "Needs attention", tone: "danger" } },
        { title: "Container image", detail: dockerBuild.success ? `Built image: ${dockerBuild.image}` : dockerBuild.error || "Image build was not completed.", status: stageStatus(dockerBuild.attempted, dockerBuild.success) },
        { title: "Kubernetes manifest", detail: kubernetesGeneration.success ? `Generated: ${(kubernetesGeneration.files || []).join(", ")}` : kubernetesGeneration.error || "Manifest generation was not completed.", status: stageStatus(kubernetesGeneration.attempted, kubernetesGeneration.success) },
        { title: "Cluster deployment", detail: kubernetesDeployment.success ? `Running as ${kubernetesDeployment.deployment}.` : kubernetesDeployment.error || "Cluster deployment was not completed.", status: stageStatus(kubernetesDeployment.attempted, kubernetesDeployment.success) }
    ];

    const deploymentReady = stages.every((stage) => stage.status.tone === "success");
    const headline = deploymentReady ? "Ready to observe" : "Follow-up required";
    const summary = deploymentReady
        ? "The workload completed the delivery pipeline and is available for live observation."
        : "One or more delivery stages require attention before the workload can be considered ready.";
    const recommendation = deploymentReady
        ? "Monitor the live CPU, memory, response-time, and probe-error trends to establish a normal operating baseline."
        : "Review the stage marked for attention, correct the underlying issue, and rerun the deployment from the workspace.";

    return (
        <main className="report-page report-document">
            <header className="report-cover">
                <div>
                    <p className="eyebrow">CloudDesk · deployment brief</p>
                    <h1>Deployment report</h1>
                    <p>A clear record of delivery readiness and the current operational snapshot.</p>
                </div>
                <div className={`report-verdict report-verdict--${deploymentReady ? "ready" : "attention"}`}>
                    <span>Decision</span>
                    <strong>{headline}</strong>
                </div>
            </header>

            <section className="report-metadata" aria-label="Deployment details">
                <div><span>Repository</span><strong>{repoName}</strong></div>
                <div><span>Deployment ID</span><strong>{jobId}</strong></div>
                <div><span>Generated</span><strong>{new Date().toLocaleString()}</strong></div>
            </section>

            <section className="report-summary">
                <div>
                    <p className="eyebrow">Executive summary</p>
                    <h2>{headline}</h2>
                </div>
                <p>{summary}</p>
            </section>

            <section className="report-section report-ai-section">
                <div className="section-heading">
                    <div><p className="eyebrow">Evidence-based decision layer</p><h2>AI deployment report</h2></div>
                    <span>{reportIsOutdated ? "Outdated — source results changed" : aiResult ? "Generated from saved results" : Object.values(prerequisites).every(Boolean) ? "Ready to generate" : "Prerequisites required"}</span>
                </div>
                {!Object.values(prerequisites).every(Boolean) ? (
                    <div className="report-prerequisite">
                        <p>Generate this report after the existing CPU/memory test, Load Testing result, and Cost Estimation result are all complete. No test or estimate is started from this page.</p>
                        <ul>
                            <li className={prerequisites.cpuMemory ? "is-ready" : "is-missing"}>CPU and memory testing: {prerequisites.cpuMemory ? "complete" : "missing"} <button onClick={() => navigate("/monitoring")}>Open Observability</button></li>
                            <li className={prerequisites.loadTesting ? "is-ready" : "is-missing"}>Load Testing: {prerequisites.loadTesting ? "complete" : "missing"} <button onClick={() => navigate("/load-testing")}>Open Load Testing</button></li>
                            <li className={prerequisites.costEstimation ? "is-ready" : "is-missing"}>Cost Estimation: {prerequisites.costEstimation ? "complete" : "missing"} <button onClick={() => navigate("/cost-estimation")}>Open Cost Estimation</button></li>
                        </ul>
                    </div>
                ) : (
                    <div className="report-ai-content">
                        <p>All required existing results are available. The AI interprets them; it does not rerun tests or recalculate pricing. {reportIsOutdated ? "The previous report is marked outdated because a source result changed." : ""}</p>
                        <button className="primary-button" onClick={createAiReport} disabled={generating}>{generating ? "Generating report…" : aiResult ? "Regenerate from latest results" : "Generate AI report"}</button>
                        {aiError && <p className="error-banner" role="alert">{aiError}</p>}
                        {aiResult && <article className="ai-report-output">
                            <h3>Executive summary</h3><p>{aiResult.report.executiveSummary}</p>
                            <h3>Key findings</h3><ul>{aiResult.report.keyFindings.map((item) => <li key={item}>{item}</li>)}</ul>
                            <h3>Verified facts</h3><ul>{(aiResult.report.verifiedFacts || []).map((item) => <li key={item}>{item}</li>)}</ul>
                            <h3>Derived values</h3><ul>{(aiResult.report.derivedValues || []).map((item) => <li key={item}>{item}</li>)}</ul>
                            <h3>Recommendations</h3><ul>{(aiResult.report.recommendations || []).map((item) => <li key={item}>{item}</li>)}</ul>
                            <h3>Performance analysis</h3><p>{aiResult.report.performanceAnalysis.summary || "Not provided"}</p>
                            <h3>Infrastructure recommendation</h3><p>{aiResult.report.infrastructureRecommendations.summary || JSON.stringify(aiResult.report.infrastructureRecommendations)}</p>
                            <h3>Cost analysis</h3><p>{aiResult.report.costAnalysis.summary || JSON.stringify(aiResult.report.costAnalysis)}</p>
                            <h3>Risks and limitations</h3><ul>{aiResult.report.risksAndLimitations.map((item) => <li key={item}>{item}</li>)}</ul>
                            <h3>Missing information</h3><ul>{(aiResult.report.missingInformation || []).map((item) => <li key={item}>{item}</li>)}</ul>
                            <h3>Final conclusion</h3><p>{aiResult.report.finalConclusion}</p>
                        </article>}
                    </div>
                )}
            </section>

            <section className="report-section">
                <div className="section-heading">
                    <div><p className="eyebrow">Delivery record</p><h2>Pipeline outcome</h2></div>
                    <span>{stages.filter((stage) => stage.status.tone === "success").length} of {stages.length} stages passed</span>
                </div>
                <div className="pipeline-record">
                    {stages.map((stage, index) => (
                        <article className="pipeline-row" key={stage.title}>
                            <span className="pipeline-number">0{index + 1}</span>
                            <div><h3>{stage.title}</h3><p>{stage.detail}</p></div>
                            <strong className={`document-status document-status--${stage.status.tone}`}>{stage.status.label}</strong>
                        </article>
                    ))}
                </div>
            </section>

            <section className="report-section report-section--metrics">
                <div className="section-heading">
                    <div><p className="eyebrow">Operational snapshot</p><h2>Latest live metrics</h2></div>
                    <span>{metrics?.pod ? "Reported by Prometheus" : "Waiting for Prometheus"}</span>
                </div>
                <div className="report-metrics">
                    <article><span>Active pod</span><strong>{metrics?.pod ?? "Not available"}</strong></article>
                    <article><span>CPU usage</span><strong>{metrics?.cpu == null ? "Not available" : formatMetric(metrics.cpu * 1000, "m", 2)}</strong></article>
                    <article><span>Memory</span><strong>{formatMetric(metrics?.memoryMiB, "MiB", 2)}</strong></article>
                    <article><span>Response time</span><strong>{formatMetric(metrics?.responseTimeMs, "ms")}</strong></article>
                </div>
            </section>

            <section className="report-section report-section--metrics">
                <div className="section-heading"><div><p className="eyebrow">Existing result sources</p><h2>Load and cost evidence</h2></div><span>No reruns from Report</span></div>
                <div className="report-metrics report-evidence-grid">
                    <article><span>Load throughput</span><strong>{formatMetric(currentLoadTests.at(-1)?.loadTest?.requestsPerSecond, "req/s", 2)}</strong></article>
                    <article><span>Load p95 latency</span><strong>{formatMetric(currentLoadTests.at(-1)?.loadTest?.p95ResponseTimeMs, "ms", 2)}</strong></article>
                    <article><span>Load error rate</span><strong>{formatMetric(currentLoadTests.at(-1)?.loadTest?.failedRequestPercentage, "%", 2)}</strong></article>
                    <article><span>Estimated monthly cost</span><strong>{costEstimate?.estimate?.totalMonthly == null ? "Not available" : `$${Number(costEstimate.estimate.totalMonthly).toFixed(2)}`}</strong></article>
                </div>
                {loadChartRuns.length > 0 && <div className="report-chart" aria-label="Saved load-test aggregate chart">
                    <div className="report-chart-heading"><span>Saved load-test runs</span><small>Bars are scaled only against the saved runs shown.</small></div>
                    {loadChartRuns.map((item, index) => {
                        const run = item.loadTest;
                        const throughput = Number(run.requestsPerSecond) || 0;
                        const p95 = Number(run.p95ResponseTimeMs) || 0;
                        return <div className="report-chart-row" key={item.completedAt || `${item.jobId}-${index}`}>
                            <span>{item.completedAt ? new Date(item.completedAt).toLocaleDateString() : "Saved run"}</span>
                            <div className="report-chart-measure"><i style={{ width: `${(throughput / maxThroughput) * 100}%` }} /><small>{throughput.toFixed(2)} req/s</small></div>
                            <div className="report-chart-measure report-chart-measure--latency"><i style={{ width: `${(p95 / maxP95) * 100}%` }} /><small>{p95.toFixed(2)} ms p95</small></div>
                        </div>;
                    })}
                </div>}
            </section>

            <section className="report-action">
                <div>
                    <p className="eyebrow">Recommended next step</p>
                    <h2>{deploymentReady ? "Establish a healthy baseline" : "Resolve the delivery blockers"}</h2>
                    <p>{recommendation}</p>
                </div>
                <button className="primary-button" onClick={() => navigate(deploymentReady ? "/monitoring" : "/analysis")}>
                    {deploymentReady ? "Open live observability" : "Review deployment pipeline"}
                </button>
            </section>

            <footer className="report-actions">
                <button className="back-button" onClick={() => navigate("/analysis")}>Back to pipeline</button>
                <button className="print-button" onClick={() => window.print()}>Print or save as PDF</button>
            </footer>
        </main>
    );
}

export default Report;
