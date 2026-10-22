import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { analyzeRepo } from "../services/api";

const workflow = [
    ["01", "Validate", "Inspect the repository and Dockerfile"],
    ["02", "Build", "Create an image for the workload"],
    ["03", "Deploy", "Apply the workload to Minikube"],
    ["04", "Observe", "Follow live Prometheus telemetry"]
];

function Home() {
    const [repository, setRepository] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const navigate = useNavigate();
    const { analysis, saveAnalysis, clearAnalysis } = useApp();

    const handleAnalyze = async (event) => {
        event.preventDefault();
        const url = repository.trim();
        if (!url) return;

        if (!url.startsWith("https://github.com/")) {
            setError("Enter a GitHub repository URL beginning with https://github.com/");
            return;
        }

        setError(null);
        setLoading(true);
        clearAnalysis();

        try {
            const result = await analyzeRepo(url);
            saveAnalysis(result);
            setLoading(false);
        } catch (requestError) {
            setError(requestError.message || "Analysis failed. Check that the local backend is running.");
        } finally {
            setLoading(false);
        }
    };

    const progressStages = analysis ? [
        ["Repository validation", analysis.validation?.dockerfile, analysis.validation?.dockerfile ? "Dockerfile found" : "Dockerfile missing"],
        ["Container build", analysis.dockerBuild?.success, analysis.dockerBuild?.success ? "Image built" : (analysis.dockerBuild?.error || "Build not completed")],
        ["Kubernetes manifests", analysis.kubernetesGeneration?.success, analysis.kubernetesGeneration?.success ? "Files generated" : (analysis.kubernetesGeneration?.error || "Generation not completed")],
        ["Cluster deployment", analysis.kubernetesDeployment?.success, analysis.kubernetesDeployment?.success ? "Deployment is live" : (analysis.kubernetesDeployment?.error || "Deployment not completed")]
    ] : [];

    return (
        <main className="home-page deploy-workspace">
            <section className="deploy-hero">
                <div className="deploy-hero__copy">
                    <p className="eyebrow">Cloud delivery workspace</p>
                    <h1>Ship a repository.<br />Watch it run.</h1>
                    <p>Validate, build, deploy, and observe a cloud-native workload from one focused workspace.</p>
                </div>
                <div className="hero-orbit" aria-hidden="true"><span /><span /><span /></div>

                <form className="deploy-form" onSubmit={handleAnalyze}>
                    <label htmlFor="repository">GitHub repository</label>
                    <div>
                        <input
                            id="repository"
                            type="url"
                            placeholder="https://github.com/org/repository"
                            value={repository}
                            onChange={(event) => {
                                setRepository(event.target.value);
                                if (error) setError(null);
                            }}
                            disabled={loading}
                        />
                        <button type="submit" disabled={loading}>{loading ? "Preparing…" : "Deploy workspace"}</button>
                    </div>
                    {error && <p className="form-message form-message--error">{error}</p>}
                    {loading && <p className="form-message">Backend is running the deployment workflow. Stage completion appears only when the backend reports it.</p>}
                    {!loading && !error && <p className="form-message">A Dockerfile in the repository root is required.</p>}
                </form>
            </section>

            {(loading || analysis) && <section className="deployment-progress" aria-live="polite">
                <div><p className="eyebrow">Deployment progress</p><h2>{loading ? "Working through the deployment pipeline" : "Deployment workflow result"}</h2></div>
                <div className="deployment-progress-list">
                    {(progressStages.length ? progressStages : [["Repository validation", null, "Waiting for backend response"], ["Container build", null, "Waiting for backend response"], ["Kubernetes manifests", null, "Waiting for backend response"], ["Cluster deployment", null, "Waiting for backend response"]]).map(([title, success, detail]) => <article key={title}><span className={`deployment-progress-dot ${success === true ? "is-success" : success === false ? "is-failure" : "is-pending"}`} /> <div><strong>{title}</strong><small>{detail}</small></div></article>)}
                </div>
                {!loading && <button className="primary-button" onClick={() => navigate("/monitoring")}>Open Observability</button>}
            </section>}

            <section className="workflow-overview">
                <div>
                    <p className="eyebrow">A clear path to production confidence</p>
                    <h2>Everything stays visible.</h2>
                </div>
                <div className="workflow-steps">
                    {workflow.map(([number, title, detail]) => (
                        <article key={number}>
                            <span>{number}</span>
                            <h3>{title}</h3>
                            <p>{detail}</p>
                        </article>
                    ))}
                </div>
            </section>
        </main>
    );
}

export default Home;
