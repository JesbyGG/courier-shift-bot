import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { apiUpload, apiSend, humanError } from "../api/client";
import { haptic } from "../telegram";
import { celebrate } from "../lib/celebrate";
import { Screen, ScreenHead, PressButton } from "../components/ui";
import { useMe } from "../state/MeContext";

const STAGE_LABEL = { start: "старт смены", end: "конец смены" };

export default function Mileage() {
  const navigate = useNavigate();
  const { refresh } = useMe();
  const fileRef = useRef(null);
  const [phase, setPhase] = useState("capture"); // capture | recognizing | review | saving
  const [stage, setStage] = useState(null);
  const [value, setValue] = useState("");
  const [recognized, setRecognized] = useState(null);

  // Сразу открываем камеру — минимум действий.
  useEffect(() => {
    const t = setTimeout(() => fileRef.current?.click(), 250);
    return () => clearTimeout(t);
  }, []);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhase("recognizing");
    haptic("light");
    try {
      const res = await apiUpload("/mileage/recognize", file, "photo");
      if (!res.ok) {
        toast.error(humanError(res.error));
        setPhase("capture");
        return;
      }
      setStage(res.stage);
      setRecognized(res.recognized);
      setValue(res.recognized ? String(res.recognized) : "");
      setPhase("review");
      if (res.recognized) {
        haptic("success");
        toast.success("Пробег распознан — проверьте число");
      } else {
        haptic("warning");
        toast("Не удалось распознать — введите вручную");
      }
    } catch (err) {
      toast.error(humanError(err.code));
      setPhase("capture");
    }
  }

  async function save() {
    const num = value.replace(/\D/g, "");
    if (num.length < 2 || num.length > 6) {
      haptic("error");
      toast.error("Введите от 2 до 6 цифр");
      return;
    }
    setPhase("saving");
    try {
      const res = await apiSend("/mileage/save", { stage, value: num });
      if (!res.ok) {
        haptic("error");
        toast.error(humanError(res.error));
        setPhase("review");
        return;
      }
      haptic("success");
      celebrate();
      toast.success(`🚗 Пробег записан · ${res.value} км`);
      await refresh();
      navigate("/");
    } catch (err) {
      haptic("error");
      toast.error(humanError(err.code));
      setPhase("review");
    }
  }

  return (
    <Screen>
      <ScreenHead
        title="Пробег"
        sub="Сфотографируйте одометр — число распознается автоматически."
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFile}
        style={{ display: "none" }}
      />

      {phase === "capture" ? (
        <div className="card center-col">
          <div style={{ fontSize: 52 }}>📷</div>
          <p className="muted" style={{ textAlign: "center" }}>
            Сделайте фото одометра автомобиля
          </p>
          <div className="spacer" />
          <PressButton onClick={() => fileRef.current?.click()}>
            Открыть камеру
          </PressButton>
        </div>
      ) : null}

      {phase === "recognizing" ? (
        <div className="card center-col">
          <div className="spinner" />
          <p className="muted">Распознаю пробег…</p>
        </div>
      ) : null}

      {(phase === "review" || phase === "saving") && stage ? (
        <motion.div
          className="card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="field-label">
            Пробег · {STAGE_LABEL[stage] || stage}
          </div>
          <input
            className="input"
            type="tel"
            inputMode="numeric"
            value={value}
            placeholder="00000"
            onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <div className="hint">
            {recognized
              ? "Распознано автоматически. Поправьте, если неверно."
              : "Введите показания одометра вручную."}
          </div>
          <div className="spacer" />
          <PressButton
            className="success"
            onClick={save}
            disabled={phase === "saving"}
          >
            {phase === "saving" ? "Сохраняю…" : "Сохранить пробег"}
          </PressButton>
          <div className="spacer" />
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>
            Переснять фото
          </button>
        </motion.div>
      ) : null}
    </Screen>
  );
}
