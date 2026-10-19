import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";

// --------------------------------------------------
// Derive a display status from attempted + success
// --------------------------------------------------
function stepStatus(attempted, success) {
    if (!attempted) return "SKIPPED";
    if (success)    return "PASS";
    return "FAIL";
}

function StatusBadge({ status }) {
    const cls =
        status === "PASS"    ? "status-pass" :
        status === "FAIL"    ? "status-fail" :
        status === "SKIPPED" ? "status-skipped" : "";
    return <strong className={cls}>{status}</strong>;
}

function DeploymentAnalysis() {
    const navigate = useNavigate();
    const { analysis } = useApp();

    // No analysis in context — guide the user back home
    if (!analysis) {
        return (
            <div className="analysis-page">
                <header className="page-header">
                    <h1>Cloud Deployment Decision Support Platform</h1>
                    <p>Deployment analysis</p>
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

    const { repository, validation, dockerBuild, kubernetesGeneration, kubernetesDeployment } = analysis;

    return (
        <div className="analysis-page">

            <header className="page-header">
                <h1>Cloud Deployment Decision Support Platform</h1>
                <p>Deployment analysis</p>
            </header>

            <div className="repository-display">
                <span>Repository</span>
                <p>{repository}</p>
            </div>

            <div className="analysis-list">

                {/* Step 1 — Dockerfile validation */}
                <div className="analysis-item">
                    <div>
                        <h3>Dockerfile Validation</h3>
                        <p>
                            {validation.dockerfile
                                ? "Dockerfile detected in repository root"
                                : "No Dockerfile found — Docker build was skipped"}
                        </p>
                    </div>
                    <StatusBadge status={validation.dockerfile ? "PASS" : "FAIL"} />
                </div>

                {/* Step 2 — Docker build */}
                <div className="analysis-item">
                    <div>
                        <h3>Docker Image Build</h3>
                        <p>
                            {!dockerBuild.attempted
                                ? "Skipped — no Dockerfile"
                                : dockerBuild.success
                                    ? `Image built: ${dockerBuild.image}`
                                    : `Build failed: ${dockerBuild.error || "unknown error"}`}
                        </p>
                    </div>
                    <StatusBadge status={stepStatus(dockerBuild.attempted, dockerBuild.success)} />
                </div>

                {/* Step 3 — Kubernetes file generation */}
                <div className="analysis-item">
                    <div>
                        <h3>Kubernetes File Generation</h3>
                        <p>
                            {!kubernetesGeneration.attempted
                                ? "Skipped — Docker build did not succeed"
                                : kubernetesGeneration.success
                                    ? `Generated: ${(kubernetesGeneration.files || []).join(", ")}`
                                    : `Generation failed: ${kubernetesGeneration.error || "unknown error"}`}
                        </p>
                    </div>
                    <StatusBadge status={stepStatus(kubernetesGeneration.attempted, kubernetesGeneration.success)} />
                </div>

                {/* Step 4 — Kubernetes deployment */}
                <div className="analysis-item">
                    <div>
                        <h3>Kubernetes Deployment</h3>
                        <p>
                            {!kubernetesDeployment.attempted
                                ? "Skipped — previous step did not succeed"
                                : kubernetesDeployment.success
                                    ? `Deployed: ${kubernetesDeployment.deployment} / Service: ${kubernetesDeployment.service}`
                                    : `Deployment failed: ${kubernetesDeployment.error || "unknown error"}`}
                        </p>
                    </div>
                    <StatusBadge status={stepStatus(kubernetesDeployment.attempted, kubernetesDeployment.success)} />
                </div>

            </div>

            <div className="bottom-navigation">

                <button onClick={() => navigate("/")}>
                    ← Home
                </button>

                <div>
                    <button onClick={() => navigate("/monitoring")}>
                        Dashboard
                    </button>

                    <button onClick={() => navigate("/assessment")}>
                        Deployment Assessment
                    </button>

                    <button onClick={() => navigate("/report")}>
                        Report
                    </button>
                </div>

            </div>

        </div>
    );
}

export default DeploymentAnalysis;
