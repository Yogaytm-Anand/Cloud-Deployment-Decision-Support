import { createContext, useContext, useState, useCallback } from "react";

// --------------------------------------------------
// AppContext — single source of truth for analysis
// results and Prometheus metrics. Persists analysis
// to sessionStorage so page refreshes keep state.
// --------------------------------------------------

const SESSION_KEY = "cdds_analysis";
const LOAD_TEST_KEY = "cdds_load_tests";

const AppContext = createContext(null);

export function AppProvider({ children }) {
    // analysis: the full POST /api/analyze response object, or null
    // Restored directly from sessionStorage on application startup
    const [analysis, setAnalysis] = useState(() => {
        try {
            const stored = sessionStorage.getItem(SESSION_KEY);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch {
            sessionStorage.removeItem(SESSION_KEY);
        }
        return null;
    });

    // metrics: the latest GET /api/metrics response object, or null
    const [metrics, setMetrics] = useState(null);
    const [loadTests, setLoadTests] = useState(() => {
        try {
            return JSON.parse(sessionStorage.getItem(LOAD_TEST_KEY) || "[]");
        } catch {
            return [];
        }
    });

    const saveLoadTest = useCallback((result) => {
        setLoadTests((previous) => {
            const next = [...previous.filter((item) => item.jobId !== result.jobId), result].slice(-12);
            try { sessionStorage.setItem(LOAD_TEST_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    }, []);

    // Save a new analysis result and clear any stale metrics
    const saveAnalysis = useCallback((result) => {
        setAnalysis(result);
        setMetrics(null);
        setLoadTests((previous) => previous.filter((item) => item.jobId === result.jobId));
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(result));
        } catch {
            // sessionStorage unavailable — state lives in memory only
        }
    }, []);

    // Clear everything (called when a new analysis starts)
    const clearAnalysis = useCallback(() => {
        setAnalysis(null);
        setMetrics(null);
        setLoadTests([]);
        try {
            sessionStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(LOAD_TEST_KEY);
        } catch {}
    }, []);

    return (
        <AppContext.Provider
            value={{ analysis, metrics, loadTests, setMetrics, saveAnalysis, saveLoadTest, clearAnalysis }}
        >
            {children}
        </AppContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApp() {
    const ctx = useContext(AppContext);
    if (!ctx) {
        throw new Error("useApp must be used inside <AppProvider>");
    }
    return ctx;
}
