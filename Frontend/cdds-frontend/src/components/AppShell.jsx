import { NavLink } from "react-router-dom";
import { useApp } from "../context/AppContext";

const navigation = [
    { to: "/", label: "Deploy", mark: "01" },
    { to: "/analysis", label: "Pipeline", mark: "02" },
    { to: "/monitoring", label: "Observability", mark: "03" },
    { to: "/load-testing", label: "Load testing", mark: "04" },
    { to: "/report", label: "Report", mark: "05" },
    { to: "/cost-estimation", label: "Cost Estimation", mark: "06" }
];

function AppShell({ children }) {
    const { analysis } = useApp();

    return (
        <div className="product-shell">
            <aside className="app-navigation">
                <NavLink to="/" className="nav-brand" aria-label="Cloud deployment workspace home">
                    <span>CD</span>
                    <strong>CloudDesk</strong>
                </NavLink>

                <p className="nav-section-label">Workspace</p>
                <nav aria-label="Primary navigation">
                    {navigation.map(({ to, label, mark }) => (
                        <NavLink
                            className={({ isActive }) => `nav-link ${isActive ? "nav-link--active" : ""}`}
                            key={to}
                            to={to}
                        >
                            <span>{mark}</span>{label}
                        </NavLink>
                    ))}
                </nav>

                <div className="nav-environment">
                    <span className="nav-section-label">Environment</span>
                    <strong><i /> Local Minikube</strong>
                    <small>{analysis?.jobId ? "Deployment selected" : "Ready to deploy"}</small>
                </div>
            </aside>
            <div className="product-main">{children}</div>
        </div>
    );
}

export default AppShell;
