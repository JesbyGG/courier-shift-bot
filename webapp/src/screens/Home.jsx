import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useMe } from "../state/MeContext";
import { apiSend } from "../api/client";
import { humanError } from "../api/client";
import { haptic, confirmPopup } from "../telegram";
import { celebrate } from "../lib/celebrate";
import { Loader } from "../components/ui";

function initials(fio) {
  if (!fio) return "🙂";
  const parts = String(fio).trim().split(/\s+/);
  return (parts[0]?.[0] || "") + (parts[1]?.[0] || "");
}

function timeTile(shift) {
  const next = shift?.time?.nextStage;
  if (next === "start") return { title: "Старт смены", meta: "Отметить начало", cls: "primary", icon: "▶️" };
  if (next === "end") return { title: "Конец смены", meta: "Отметить завершение", cls: "primary", icon: "⏹" };
  return { title: "Смена закрыта", meta: "Время отмечено · можно изменить", cls: "", icon: "✅" };
}

const tileVariants = {
  hidden: { opacity: 0, y: 18, scale: 0.96 },
  show: (i) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { delay: 0.05 + i * 0.05, ease: [0.22, 0.61, 0.36, 1] },
  }),
};

function Tile({ index, className = "", icon, title, meta, badge, onClick }) {
  return (
    <motion.div
      className={`tile ${className}`}
      custom={index}
      variants={tileVariants}
      initial="hidden"
      animate="show"
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
    >
      <div className="shine" />
      {badge ? <div className="tile-badge">{badge}</div> : null}
      <div className="tile-icon">{icon}</div>
      <div>
        <div className="tile-title">{title}</div>
        <div className="tile-meta">{meta}</div>
      </div>
    </motion.div>
  );
}

export default function Home() {
  const { me, loading, refresh } = useMe();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);

  if (loading || !me) return <Loader />;

  if (!me.registered) {
    return (
      <div className="card" style={{ marginTop: 40 }}>
        <div className="screen-title">Нужна регистрация</div>
        <p className="muted" style={{ marginTop: 10 }}>
          Откройте бота и пройдите регистрацию командой <b>/start</b>, затем
          вернитесь сюда.
        </p>
      </div>
    );
  }

  const { profile, shift, pendingCash, features } = me;
  const isPedestrian = profile.courierType === "pedestrian";
  const tt = timeTile(shift);

  async function doPunch() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiSend("/time/punch");
      if (res.needsReplaceChoice) {
        setReplaceOpen(true);
        return;
      }
      if (!res.ok) {
        haptic("error");
        toast.error(humanError(res.error));
        return;
      }
      haptic("success");
      celebrate();
      toast.success(
        `${res.stage === "start" ? "🟢 Старт" : "🔴 Конец"} смены · ${res.timeValue}`,
      );
      await refresh();
    } catch (e) {
      haptic("error");
      toast.error(humanError(e.code));
    } finally {
      setBusy(false);
    }
  }

  async function doReplace(stage) {
    setReplaceOpen(false);
    setBusy(true);
    try {
      const res = await apiSend("/time/replace", { stage });
      if (!res.ok) {
        haptic("error");
        toast.error(humanError(res.error));
        return;
      }
      haptic("success");
      celebrate();
      toast.success(`Время обновлено · ${res.timeValue}`);
      await refresh();
    } catch (e) {
      haptic("error");
      toast.error(humanError(e.code));
    } finally {
      setBusy(false);
    }
  }

  async function doSubmitCash() {
    if (busy) return;
    const ok = await confirmPopup(
      `Подтвердить сдачу ${pendingCash.number} ₽?`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiSend("/cash/submit");
      haptic("success");
      celebrate();
      toast.success(
        res.awaiting
          ? "Запрос отправлен логисту"
          : "Сдача подтверждена. Спасибо!",
      );
      await refresh();
    } catch (e) {
      haptic("error");
      toast.error(humanError(e.code));
    } finally {
      setBusy(false);
    }
  }

  function go(path) {
    haptic("light");
    navigate(path);
  }

  let i = 0;
  return (
    <div>
      <motion.div
        className="hero"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="hero-avatar">{initials(profile.fio)}</div>
        <div>
          <div className="hero-greet">С возвращением 👋</div>
          <div className="hero-name">{profile.fio || "Курьер"}</div>
          <div className="hero-sub">
            {[profile.workplace, profile.device].filter(Boolean).join(" · ") ||
              "Профиль не заполнен"}
          </div>
        </div>
      </motion.div>

      <div className="status-row">
        <StatusPill label="Время" status={shift.time.status} />
        {!isPedestrian ? (
          <StatusPill label="Пробег" status={shift.mileage.status} />
        ) : null}
      </div>

      <div className="tiles">
        <Tile
          index={i++}
          className={`span-2 ${tt.cls}`}
          icon={tt.icon}
          title={tt.title}
          meta={busy ? "Секунду…" : tt.meta}
          onClick={tt.cls === "primary" ? doPunch : () => setReplaceOpen(true)}
        />

        {!isPedestrian ? (
          <Tile
            index={i++}
            icon="🚗"
            title="Пробег"
            meta="Фото одометра"
            onClick={() => go("/mileage")}
          />
        ) : null}

        <Tile
          index={i++}
          icon="📄"
          title="Маршрутник"
          meta="Загрузить фото"
          onClick={() => go("/route-sheet")}
        />
        <Tile
          index={i++}
          icon="📊"
          title="Сверка"
          meta={profile.device === "Терминал" ? "2 фото" : "1 фото"}
          onClick={() => go("/reconciliation")}
        />

        {pendingCash ? (
          <Tile
            index={i++}
            className="span-2 danger"
            icon="💵"
            title={`К сдаче · ${pendingCash.number} ₽`}
            meta="Нажмите, чтобы отметить сдачу"
            onClick={doSubmitCash}
          />
        ) : null}

        <Tile
          index={i++}
          className="span-2"
          icon="⚙️"
          title="Профиль"
          meta="Машина · магазин · устройство"
          onClick={() => go("/profile")}
        />
      </div>

      <AnimatePresence>
        {replaceOpen ? (
          <Sheet onClose={() => setReplaceOpen(false)}>
            <div className="screen-title" style={{ fontSize: 20 }}>
              Что заменить?
            </div>
            <p className="muted" style={{ margin: "8px 0 16px" }}>
              Время уже отмечено. Выберите, какую отметку перезаписать текущим
              временем.
            </p>
            <div className="btn-row">
              <button className="btn ghost" onClick={() => doReplace("start")}>
                🟢 Старт
              </button>
              <button className="btn" onClick={() => doReplace("end")}>
                🔴 Конец
              </button>
            </div>
          </Sheet>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function StatusPill({ label, status }) {
  const dot =
    status === "both" ? "on" : status === "start" || status === "end" ? "half" : "";
  const text =
    status === "both"
      ? "Завершено"
      : status === "start"
        ? "Старт отмечен"
        : status === "end"
          ? "Конец отмечен"
          : "Не начато";
  return (
    <div className="status-pill">
      <span className="label">{label}</span>
      <span className="value">
        <span className={`dot ${dot}`} />
        {text}
      </span>
    </div>
  );
}

function Sheet({ children, onClose }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 50,
      }}
    >
      <motion.div
        initial={{ y: 260 }}
        animate={{ y: 0 }}
        exit={{ y: 260 }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: "100%",
          maxWidth: 560,
          margin: "0 auto",
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
        }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
