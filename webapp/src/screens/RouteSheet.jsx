import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { apiUpload, humanError } from "../api/client";
import { haptic } from "../telegram";
import { celebrate } from "../lib/celebrate";
import { Screen, ScreenHead, PressButton } from "../components/ui";

export default function RouteSheet() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [photos, setPhotos] = useState([]); // {file, url}
  const [sending, setSending] = useState(false);

  function add(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    haptic("light");
    setPhotos((prev) => [
      ...prev,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
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
        "/route-sheet",
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
      toast.success(`📄 Отправлено фото: ${res.count}`);
      navigate("/");
    } catch (e) {
      haptic("error");
      toast.error(humanError(e.code));
    } finally {
      setSending(false);
    }
  }

  return (
    <Screen>
      <ScreenHead
        title="Маршрутник"
        sub="Добавьте фото маршрутных листов и отправьте одним нажатием."
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={add}
        style={{ display: "none" }}
      />

      <div className="card">
        <div className="field-label">Фото · {photos.length}</div>
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
          <div className="thumb add" onClick={() => fileRef.current?.click()}>
            +
          </div>
        </div>
      </div>

      <div className="spacer" />
      <PressButton
        className="success"
        onClick={send}
        disabled={!photos.length || sending}
      >
        {sending ? "Отправляю…" : `Отправить${photos.length ? ` (${photos.length})` : ""}`}
      </PressButton>
    </Screen>
  );
}
