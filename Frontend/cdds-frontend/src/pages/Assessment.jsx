import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";

// --------------------------------------------------
// Derive overall readiness from the complete pipeline.
// Distinguishes: successful | failed | skipped | unavailable.
// Never collapses all failure modes to kubernetesDeployment.success.
// --------------------------------------------------
function deriveOverallStatus(analysis) {
    if (!analysis) return { label: "Unavailable", cls: "status-skipped", detail: "No analysis has been run yet." };

    const { validation, dockerBuild, kubernetesGeneration, kubernetesDeployment } = analysis;

    if (!validation.dockerfile) {
        return { label: "Failed", cls: "status-fail", detail: "No Dockerfile found. The pipeline could not start." };
    }
    if (dockerBuild.attempted && !dockerBuild.success) {
        return { label: "Failed", cls: "status-fail", detail: `Docker build error: ${dockerBuild.error || "see logs"}` };
    }
    if (!dockerBuild.attempted) {
        return { label: "Incomplete", cls: "status-skipped", detail: "Docker build was skipped." };
    }
    if (kubernetesGeneration.attempted && !kubernetesGeneration.success) {
        return { label: "Failed", cls: "status-fail", detail: `Kubernetes file generation failed: ${kubernetesGeneration.error || "see logs"}` };
    }
    if (!kubernetesGeneration.attempted) {
        return { label: "Incomplete", cls: "status-skipped", detail: "Kubernetes file generation was skipped." };
    }
    if (!kubernetesDeployment.attempted) {
        return { label: "Incomplete", cls: "status-skipped", detail: "Kubernetes deployment was skipped because a prior step failed." };
    }
    if (kubernetesDeployment.attempted && !kubernetesDeployment.success) {
        return { label: "Failed", cls: "status-fail", detail: `Kubernetes deployment failed: ${kubernetesDeployment.error || "see logs"}` };
    }
    return { label: "Deployed", cls: "status-pass", detail: `Deployment ${kubernetesDeployment.deployment} is live.` };
}

function stepStatus(attempted, success) {
    if (!attempted) return { label: "SKIPPED", cls: "status-skipped" };
    if (success)    return { label: "PASS",    cls: "status-pass"    };
    return              { label: "FAIL",    cls: "status-fail"    };
}

function Assessment() {
    const navigate = useNavigate();
    const { analysis } = useApp();

    if (!analysis) {
        return (
            <div className="assessment-page">
                <header className="page-header">
                    <h1>Cloud Deployment Decision Support Platform</h1>
                    <p>Deployment Assessment</p>
                </header>
                <div className="empty-state">
                    <p>No analysis available.</p>
                    <button className="back-button" onClick={() => navigate("/")}>
                        ← Submit a repository
                    </button>
                </div>
            </div>
        );
    }

    const { validation, dockerBuild, kubernetesGeneration, kubernetesDeployment } = analysis;
    const overall = deriveOverallStatus(analysis);

    const dockerfile   = { label: validation.dockerfile  ? "PASS" : "FAIL", cls: validation.dockerfile ? "status-pass" : "status-fail" };
    const build        = stepStatus(dockerBuild.attempted,          dockerBuild.success);
    const k8sGen       = stepStatus(kubernetesGeneration.attempted, kubernetesGeneration.success);
    const k8sDeploy    = stepStatus(kubernetesDeployment.attempted, kubernetesDeployment.success);

    // Dynamic findings — only truths from real data
    const findings = [];
    if (!validation.dockerfile)            findings.push("No Dockerfile was found in the repository root.");
    if (dockerBuild.attempted && dockerBuild.success)
                                           findings.push(`Docker image built successfully: ${dockerBuild.image}`);
    if (dockerBuild.attempted && !dockerBuild.success)
                                           findings.push(`Docker build failed: ${dockerBuild.error || "unknown error"}`);
    if (kubernetesGeneration.success)      findings.push(`Kubernetes YAML generated: ${(kubernetesGeneration.files || []).join(", ")}`);
    if (kubernetesDeployment.success)      findings.push(`Pod deployed: ${kubernetesDeployment.deployment} | Service: ${kubernetesDeployment.service}`);
    if (kubernetesDeployment.attempted && !kubernetesDeployment.success)
                                           findings.push(`Kubernetes deployment failed: ${kubernetesDeployment.error || "unknown error"}`);
    if (!kubernetesDeployment.attempted)   findings.push("Kubernetes deployment was not attempted (a previous step failed or was skipped).");

    // Dynamic recommendations — only for failed/skipped steps
    const recs = [];
    if (!validation.dockerfile)            recs.push("Add a Dockerfile to the repository root before rerunning the pipeline.");
    if (dockerBuild.attempted && !dockerBuild.success)
                                           recs.push("Fix the Docker build errors shown above, then resubmit the repository.");
    if (kubernetesGeneration.attempted && !kubernetesGeneration.success)
                                           recs.push("Investigate Kubernetes file generation errors and retry.");
    if (kubernetesDeployment.attempted && !kubernetesDeployment.success)
                                           recs.push("Verify Minikube is running and kubectl is configured correctly, then redeploy.");
    if (recs.length === 0)                 recs.push("All pipeline steps completed successfully. Monitor resource usage in the Dashboard.");

    return (
        <div className="assessment-page">

            <header className="page-header">
                <h1>Cloud Deployment Decision Support Platform</h1>
                <p>Deployment Assessment</p>
            </header>

            <section className="assessment-grid">

                <div className="assessment-card">
                    <h3>Dockerfile</h3>
                    <span>REPOSITORY VALIDATION</span>
                    <small>STATUS</small>
                    <strong className={dockerfile.cls}>{dockerfile.label}</strong>
                </div>

                <div className="assessment-card">
                    <h3>Docker Build</h3>
                    <span>IMAGE CREATION</span>
                    <small>STATUS</small>
                    <strong className={build.cls}>{build.label}</strong>
                </div>

                <div className="assessment-card">
                    <h3>K8s Generation</h3>
                    <span>YAML FILES</span>
                    <small>STATUS</small>
                    <strong className={k8sGen.cls}>{k8sGen.label}</strong>
                </div>

                <div className="assessment-card">
                    <h3>K8s Deployment</h3>
                    <span>CLUSTER ROLLOUT</span>
                    <small>STATUS</small>
                    <strong className={k8sDeploy.cls}>{k8sDeploy.label}</strong>
                </div>

            </section>

            <section className="wide-card">
                <h3>Key Findings</h3>
                <ul>
                    {findings.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
            </section>

            <section className="summary-card">
                <h3>Overall Readiness</h3>
                <span>PIPELINE STATUS</span>
                <small>ASSESSMENT</small>
                <strong className={overall.cls}>{overall.label}</strong>
                <p className="summary-detail">{overall.detail}</p>
            </section>

            <section className="wide-card">
                <h3>Recommendations</h3>
                <ul>
                    {recs.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
            </section>

            <button
                className="back-button"
                onClick={() => navigate("/analysis")}
            >
                ← Back
            </button>

        </div>
    );
}

export default Assessment;
