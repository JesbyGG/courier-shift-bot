import { useEffect } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { useMe } from "./state/MeContext";
import { humanError } from "./api/client";
import { showBackButton } from "./telegram";
import Home from "./screens/Home";
import Mileage from "./screens/Mileage";
import Reconciliation from "./screens/Reconciliation";
import RouteSheet from "./screens/RouteSheet";
import Profile from "./screens/Profile";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { error } = useMe();

  // Нативная кнопка «Назад» Telegram на внутренних экранах.
  useEffect(() => {
    if (location.pathname === "/") return undefined;
    return showBackButton(() => navigate("/"));
  }, [location.pathname, navigate]);

  return (
    <div className="app">
      <div className="app-bg" />
      {error && location.pathname === "/" ? (
        <div className="card" style={{ marginTop: 30 }}>
          <div className="screen-title" style={{ fontSize: 20 }}>
            Не удалось подключиться
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            {humanError(error)}
          </p>
        </div>
      ) : (
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<Home />} />
            <Route path="/mileage" element={<Mileage />} />
            <Route path="/reconciliation" element={<Reconciliation />} />
            <Route path="/route-sheet" element={<RouteSheet />} />
            <Route path="/profile" element={<Profile />} />
          </Routes>
        </AnimatePresence>
      )}
    </div>
  );
}
