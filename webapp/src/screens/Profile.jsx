import { useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { apiSend, humanError } from "../api/client";
import { haptic } from "../telegram";
import { Screen, ScreenHead } from "../components/ui";
import { useMe } from "../state/MeContext";

function Segment({ options, value, onPick }) {
  return (
    <div className="segment">
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            className={active ? "active" : ""}
            onClick={() => onPick(opt)}
          >
            {active ? (
              <motion.span layoutId="segpill" className="seg-pill" />
            ) : null}
            {opt}
          </button>
        );
      })}
    </div>
  );
}

export default function Profile() {
  const { me, refresh } = useMe();
  const profile = me?.profile || {};
  const [car, setCar] = useState(profile.carNumber || "");
  const [saving, setSaving] = useState(false);

  async function patch(field, val) {
    setSaving(true);
    try {
      const res = await apiSend("/profile", { [field]: val }, "PATCH");
      if (!res.ok) {
        haptic("error");
        toast.error(humanError(res.error));
        return false;
      }
      haptic("success");
      toast.success("Сохранено");
      await refresh();
      return true;
    } catch (e) {
      haptic("error");
      toast.error(humanError(e.code));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function pickWorkplace(wp) {
    if (wp === profile.workplace) return;
    haptic("select");
    patch("workplace", wp);
  }
  function pickDevice(d) {
    if (d === profile.device) return;
    haptic("select");
    patch("device", d);
  }
  function saveCar() {
    const v = car.trim();
    if (!v || v === (profile.carNumber || "")) return;
    patch("carNumber", v);
  }

  return (
    <Screen>
      <ScreenHead title="Профиль" sub="Изменения сохраняются автоматически." />

      <div className="card">
        <div className="field-row">
          <div className="field-label">ФИО</div>
          <div className="field-static">{profile.fio || "—"}</div>
        </div>

        <div className="field-row">
          <div className="field-label">Магазин</div>
          <Segment
            options={me?.workplaces || []}
            value={profile.workplace}
            onPick={pickWorkplace}
          />
        </div>

        <div className="field-row">
          <div className="field-label">Устройство</div>
          <Segment
            options={me?.devices || []}
            value={profile.device}
            onPick={pickDevice}
          />
        </div>

        <div className="field-row">
          <div className="field-label">Номер машины</div>
          <input
            className="input"
            style={{ fontSize: 17, letterSpacing: 1, textAlign: "left" }}
            value={car}
            placeholder="А000АА 00"
            onChange={(e) => setCar(e.target.value.toUpperCase())}
            onBlur={saveCar}
          />
        </div>
      </div>

      <div className="card">
        <div className="field-label">Как пользоваться</div>
        <p className="muted" style={{ marginTop: 8 }}>
          ⏱ <b>Время</b> — одна кнопка отметит старт или конец смены.<br />
          🚗 <b>Пробег</b> — фото одометра, число распознаётся само.<br />
          📄 <b>Маршрутник</b> и 📊 <b>Сверка</b> — отправка фото в пару касаний.<br />
          💵 <b>Наличные</b> — появляются на главном экране, когда есть сумма к
          сдаче.
        </p>
      </div>

      {saving ? <div className="hint">Сохранение…</div> : null}
    </Screen>
  );
}
