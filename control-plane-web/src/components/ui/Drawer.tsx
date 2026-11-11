import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { motionEnabled } from '../../lib/motion';

export function Drawer({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [open, onClose]);

  const animated = motionEnabled();
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="drawer-mask" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: animated ? 0.16 : 0 }} />
          <motion.aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : '详情'}
            initial={{ x: animated ? 40 : 0, opacity: animated ? 0.6 : 1 }}
            animate={{ x: 0, opacity: 1 }} exit={{ x: animated ? 40 : 0, opacity: animated ? 0 : 1 }}
            transition={{ duration: animated ? 0.18 : 0 }}>
            <div className="drawer-head">
              <div className="card-title">{title}</div>
              <button className="ghost" onClick={onClose} aria-label="关闭"><X size={16} /></button>
            </div>
            <div className="drawer-body">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
