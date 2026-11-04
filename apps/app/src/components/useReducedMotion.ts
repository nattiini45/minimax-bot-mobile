import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Start static until the preference is known; runtime changes win over a stale read. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      changed = true;
      setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (alive && !changed) setReduced(value);
    }).catch(() => { /* Keep the safe static default. */ });
    return () => { alive = false; subscription.remove(); };
  }, []);
  return reduced;
}
