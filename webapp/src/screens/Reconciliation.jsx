import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { apiUpload, humanError } from "../api/client";
import { haptic } from "../telegram";
import { celebrate } from "../lib/celebrate";
import { Screen, ScreenHead, PressButton } from "../components/ui";
import { useMe } from "../state/MeContext";

export default function Reconciliation() {
  const navigate = useNavigate();
  const { me, refresh } = useMe();
  const fileRef = useRef(null);
  const [photos, setPhotos] = useState([]);
  const [sending, setSending] = useState(false);

  const isTerminal = me?.profile?.device === "Терминал";
  const need = isTerminal ? 2 : 1;
  const hint = isTerminal
    ? "Терминал: 1) статистика (с суммой) и 2) чек."
    : "Пин-Панель: одно фото сверки.";

  function add(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    haptic("light");
    setPhotos((prev) =>
      [...prev, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(
        0,
        need,
      ),
    );
  }

  function remove(idx) {
    haptic("select");
    setPhotos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function send() {
    if (!photos.length || sending) return;
    setSending(true);
    try {
      const res = await apiUpload(
        "/reconciliation",
        photos.map((p) => p.file),
        "photos",
      );
      if (!res.ok) {
        haptic("error");
        toast.error(humanError(res.error));
        return;
      }
      haptic("success");
      celebrate();
      if (res.cash) {
        toast.success(`📊 Сверка отправлена · к сдаче ${res.cash.number} ₽`);
      } else {
        toast.success("📊 Сверка отправлена");
      }
      await refresh();
      navigate("/");
    } catch (e) {
      haptic("error");
      toast.error(humanError(e.code));
    } finally {
      setSending(false);
    }
  }

  const ready = photos.length >= need;

  return (
    <Screen>
      <ScreenHead title="Сверка" sub={hint} />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple={need > 1}
        onChange={add}
        style={{ display: "none" }}
      />

      <div className="card">
        <div className="field-label">
          Фото · {photos.length} из {need}
        </div>
        <div className="thumbs">
          <AnimatePresence>
            {photos.map((p, idx) => (
              <motion.div
                key={p.url}
                className="thumb"
                layout
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
              >
                <img src={p.url} alt="" />
                <button className="remove" onClick={() => remove(idx)}>
                  ✕
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
          {photos.length < need ? (
            <div className="thumb add" onClick={() => fileRef.current?.click()}>
              +
            </div>
          ) : null}
        </div>
      </div>

      <div className="spacer" />
      <PressButton
        className="success"
        onClick={send}
        disabled={!ready || sending}
      >
        {sending ? "Отправляю…" : ready ? "Отправить сверку" : `Добавьте ещё фото`}
      </PressButton>
    </Screen>
  );
}
