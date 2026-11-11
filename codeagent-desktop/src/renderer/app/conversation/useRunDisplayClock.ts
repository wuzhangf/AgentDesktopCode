import { useEffect, useState } from 'react';

/** A local display clock; it never polls the service or rebuilds query data. */
export function useRunDisplayClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const tick = (): void => {
      if (!document.hidden) setNow(Date.now());
    };
    const onVisibility = (): void => {
      if (!document.hidden) tick();
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);
  return now;
}
