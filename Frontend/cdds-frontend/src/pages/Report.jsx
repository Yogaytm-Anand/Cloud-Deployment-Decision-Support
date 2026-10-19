import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";

function stageStatus(attempted, success) {
    if (!attempted) return { label: "Not run", tone: "muted" };
    return success ? { label: "Passed", tone: "success" } : { label: "Needs attention", tone: "danger" };
}

function formatMetric(value, unit, digits = 0) {
    return value == null ? "Not available" : `${Number(value).toFixed(digits)} ${unit}`;
}

function Report() {
    const navigate = useNavigate();
    const { analysis, metrics } = useApp();

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

    const { jobId, repository, validation, dockerBuild, kubernetesGeneration, kubernetesDeployment } = analysis;
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
