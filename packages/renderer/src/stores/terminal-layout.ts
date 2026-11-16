import { create } from 'zustand';

export const clampRatio = (value: number) => Math.max(20, Math.min(80, value));
interface TerminalLayoutState {
  split: boolean;
  visible: string[];
  focus: string | null;
  columns: number;
  rows: number;
  sync: (ids: string[], active: string | null) => void;
  toggle: (ids: string[], active: string | null) => void;
  swap: (from: string, to: string) => void;
  resize: (axis: 'columns' | 'rows', ratio: number) => void;
  reset: (ids: string[], active: string | null) => void;
}
export const useTerminalLayoutStore = create<TerminalLayoutState>((set) => ({
  split: false,
  visible: [],
  focus: null,
  columns: 50,
  rows: 50,
  sync: (ids, active) =>
    set((state) => {
      if (!state.split) return { focus: active };
      const next = state.visible.filter((id) => ids.includes(id));
      if (active && !next.includes(active)) {
        if (next.length < 4) next.push(active);
        else next[Math.max(0, next.indexOf(state.focus || ''))] = active;
      }
      for (const id of ids) if (next.length < 4 && !next.includes(id)) next.push(id);
      const changedCount = next.length !== state.visible.length;
      return { visible: next, focus: active, ...(changedCount ? { columns: 50, rows: 50 } : {}) };
    }),
  toggle: (ids, active) =>
    set((state) => ({
      split: !state.split,
      visible: state.split
        ? state.visible
        : [...(active ? [active] : []), ...ids.filter((id) => id !== active)].slice(0, 4),
      focus: active,
      columns: 50,
      rows: 50,
    })),
  swap: (from, to) =>
    set((state) => {
      const visible = [...state.visible];
      const a = visible.indexOf(from);
      const b = visible.indexOf(to);
      if (a < 0 || b < 0) return state;
      [visible[a], visible[b]] = [visible[b], visible[a]];
      return { visible };
    }),
  resize: (axis, ratio) => set({ [axis]: clampRatio(ratio) }),
  reset: (ids, active) =>
    set({
      visible:
        ids.slice(0, 4).includes(active || '') || !active
          ? ids.slice(0, 4)
          : [...ids.slice(0, 3), active],
      columns: 50,
      rows: 50,
    }),
}));

export function paneBounds(index: number, count: number, columns: number, rows: number) {
  const right = count === 3 ? index > 0 : index % 2 === 1;
  const bottom = count === 3 ? index === 2 : index >= 2;
  return {
    left: `${right ? columns : 0}%`,
    top: `${bottom ? rows : 0}%`,
    width: `${count === 1 ? 100 : right ? 100 - columns : columns}%`,
    height: `${count <= 2 || (count === 3 && index === 0) ? 100 : bottom ? 100 - rows : rows}%`,
  };
}
