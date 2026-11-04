import React, { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from './store';

/** Discards account-owned local React state, including batched logout/relink to identical ids. */
export function OwnerBoundary({ children }: { children: React.ReactNode }) {
  const generation = useAppStore(state => state.ownerGeneration);
  return <React.Fragment key={generation}>{children}</React.Fragment>;
}

/** Also fences callbacks captured before React has committed the owner-boundary remount. */
export function useOwnerGuard(): () => boolean {
  const generation = useAppStore(state => state.ownerGeneration);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [generation]);
  return useCallback(() => mounted.current && useAppStore.getState().ownerGeneration === generation, [generation]);
}
