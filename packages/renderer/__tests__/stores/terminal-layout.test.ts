import { beforeEach, describe, expect, it } from 'vitest';
import { paneBounds, useTerminalLayoutStore as store } from '../../src/stores/terminal-layout';

describe('terminal split layout', () => {
  beforeEach(() =>
    store.setState({ split: false, visible: [], focus: null, columns: 50, rows: 50 })
  );
  it('starts single and opens at most four panes, prioritizing active terminal', () => {
    expect(store.getState().split).toBe(false);
    store.getState().toggle(['a', 'b', 'c', 'd', 'e'], 'e');
    expect(store.getState().visible).toEqual(['e', 'a', 'b', 'c']);
  });
  it('replaces the focused slot and keeps replacement on subsequent selection', () => {
    store.getState().toggle(['a', 'b', 'c', 'd', 'e'], 'a');
    store.getState().sync(['a', 'b', 'c', 'd', 'e'], 'c');
    store.getState().sync(['a', 'b', 'c', 'd', 'e'], 'e');
    expect(store.getState().visible).toEqual(['a', 'b', 'e', 'd']);
    store.getState().sync(['a', 'b', 'c', 'd', 'e'], 'a');
    expect(store.getState().visible).toEqual(['a', 'b', 'e', 'd']);
  });
  it('fills closed slots, swaps panes, clamps sizes and resets', () => {
    store.getState().toggle(['a', 'b', 'c', 'd', 'e'], 'a');
    store.getState().swap('a', 'd');
    expect(store.getState().visible).toEqual(['d', 'b', 'c', 'a']);
    store.getState().resize('columns', 99);
    store.getState().resize('rows', 0);
    expect(store.getState()).toMatchObject({ columns: 80, rows: 20 });
    store.getState().sync(['a', 'b', 'c', 'e'], 'a');
    expect(store.getState().visible).toEqual(['b', 'c', 'a', 'e']);
    store.getState().reset(['a', 'b', 'c', 'e'], 'a');
    expect(store.getState()).toMatchObject({
      visible: ['a', 'b', 'c', 'e'],
      columns: 50,
      rows: 50,
    });
    store.getState().toggle(['a', 'b', 'c', 'e'], 'a');
    expect(store.getState().split).toBe(false);
  });
  it('handles zero through four panes and three-pane geometry', () => {
    store.getState().toggle([], null);
    expect(store.getState().visible).toEqual([]);
    for (let count = 1; count <= 4; count++) {
      const ids = ['a', 'b', 'c', 'd'].slice(0, count);
      store.getState().sync(ids, 'a');
      expect(store.getState().visible).toHaveLength(count);
    }
    expect(paneBounds(0, 1, 50, 50)).toEqual({
      left: '0%',
      top: '0%',
      width: '100%',
      height: '100%',
    });
    expect(paneBounds(0, 3, 60, 40)).toEqual({
      left: '0%',
      top: '0%',
      width: '60%',
      height: '100%',
    });
    expect(paneBounds(2, 3, 60, 40)).toEqual({
      left: '60%',
      top: '40%',
      width: '40%',
      height: '60%',
    });
  });
});
