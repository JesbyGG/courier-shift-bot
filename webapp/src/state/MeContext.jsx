import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiGet } from "../api/client";

const MeContext = createContext(null);

export function MeProvider({ children }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet("/me");
      setMe(data);
      setError(null);
      return data;
    } catch (e) {
      setError(e.code || "load_failed");
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  return (
    <MeContext.Provider value={{ me, loading, error, refresh, setMe }}>
      {children}
    </MeContext.Provider>
  );
}

export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used within MeProvider");
  return ctx;
}
