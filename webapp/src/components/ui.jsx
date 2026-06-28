import { motion } from "framer-motion";

export function Loader() {
  return (
    <div className="loader-wrap">
      <div className="spinner" />
    </div>
  );
}

// Анимированная обёртка экрана: мягкий вход + лёгкий вертикальный сдвиг.
export function Screen({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.32, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function ScreenHead({ title, sub }) {
  return (
    <div className="screen-head">
      <motion.h1
        className="screen-title"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        {title}
      </motion.h1>
      {sub ? <p className="screen-sub">{sub}</p> : null}
    </div>
  );
}

// Прижатая к низу кнопка с пружинкой при нажатии.
export function PressButton({ children, className = "", onClick, disabled }) {
  return (
    <motion.button
      className={`btn ${className}`}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </motion.button>
  );
}
