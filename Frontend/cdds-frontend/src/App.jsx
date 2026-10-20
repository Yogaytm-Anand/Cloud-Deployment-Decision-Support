import "./App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import DeploymentAnalysis from "./pages/DeploymentAnalysis";
import Monitoring from "./pages/Monitoring";
import Report from "./pages/Report";
import CostEstimation from "./pages/CostEstimation";
import LoadTesting from "./pages/LoadTesting";
import AppShell from "./components/AppShell";

function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/analysis" element={<DeploymentAnalysis />} />
          <Route path="/monitoring" element={<Monitoring />} />
          <Route path="/report" element={<Report />} />
          <Route path="/load-testing" element={<LoadTesting />} />
          <Route path="/cost-estimation" element={<CostEstimation />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

export default App;
