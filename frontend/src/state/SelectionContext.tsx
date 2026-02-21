import { createContext, useContext, useRef } from 'react';
import type { ReactNode, MutableRefObject } from 'react';

/**
 * Ref-based context for sharing DataGrid selection between components.
 * Uses a ref (not reactive state) so selection changes in ActionTable
 * don't cause unnecessary re-renders in SettingsPanel.
 * SettingsPanel reads the ref imperatively when Enter is pressed.
 */
const SelectionContext = createContext<MutableRefObject<Set<number>>>(
  { current: new Set() } as MutableRefObject<Set<number>>
);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Set<number>>(new Set());
  return (
    <SelectionContext.Provider value={ref}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelectionRef() {
  return useContext(SelectionContext);
}
