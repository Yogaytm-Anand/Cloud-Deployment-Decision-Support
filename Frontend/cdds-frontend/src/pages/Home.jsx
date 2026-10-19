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
    const { saveAnalysis, clearAnalysis } = useApp();

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
            navigate("/monitoring");
        } catch (requestError) {
            setError(requestError.message || "Analysis failed. Check that the local backend is running.");
        } finally {
            setLoading(false);
        }
    };

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
                    {loading && <p className="form-message">Cloning, building, and deploying your workload…</p>}
                    {!loading && !error && <p className="form-message">A Dockerfile in the repository root is required.</p>}
                </form>
            </section>

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
