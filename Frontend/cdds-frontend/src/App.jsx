import "./App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import DeploymentAnalysis from "./pages/DeploymentAnalysis";
import Monitoring from "./pages/Monitoring";
import Assessment from "./pages/Assessment";
import Report from "./pages/Report";
import AppShell from "./components/AppShell";

function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/analysis" element={<DeploymentAnalysis />} />
          <Route path="/monitoring" element={<Monitoring />} />
          <Route path="/assessment" element={<Assessment />} />
          <Route path="/report" element={<Report />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

export default App;
