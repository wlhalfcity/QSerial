/** @vitest-environment jsdom */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MainContent } from '../../src/components/layout/MainContent';
import { useTerminalStore } from '../../src/stores/terminal';
import { useTerminalLayoutStore } from '../../src/stores/terminal-layout';
import { useSftpStore } from '../../src/stores/sftp';
const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/components/terminal/TerminalPane', () => ({
  TerminalPane: ({
    sessionId,
    isActive,
    isVisible,
  }: {
    sessionId: string;
    isActive: boolean;
    isVisible: boolean;
  }) => {
    React.useEffect(() => {
      mounts.count++;
    }, []);
    return <div data-testid={sessionId} data-active={isActive} data-visible={isVisible} />;
  },
}));
vi.mock('../../src/components/sftp', () => ({ SftpPanel: () => null }));
describe('terminal split integration', () => {
  beforeEach(() => {
    cleanup();
    mounts.count = 0;
    useSftpStore.setState({ panelVisible: false });
    useTerminalLayoutStore.setState({
      split: false,
      visible: [],
      focus: null,
      columns: 50,
      rows: 50,
    });
    useTerminalStore.setState({
      tabs: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
        id,
        name: id,
        sessions: [id],
        activeSessionId: id,
      })),
      activeTabId: 'a',
      sessions: Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e'].map((id) => [id, { id, name: id, connectionId: id }])
      ) as never,
    });
  });
  it('retains terminal instances through split, resize, swap and single mode', () => {
    render(<MainContent />);
    expect(mounts.count).toBe(5);
    fireEvent.click(screen.getByText('mainContent.split'));
    expect(screen.getByTestId('b').getAttribute('data-visible')).toBe('true');
    const divider = screen.getByRole('separator', { name: 'mainContent.columnDivider' });
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(useTerminalLayoutStore.getState().columns).toBe(52);
    act(() => useTerminalLayoutStore.getState().swap('a', 'b'));
    act(() => useTerminalStore.getState().setActiveTab('e'));
    expect(useTerminalLayoutStore.getState().visible).toContain('e');
    expect(screen.getByTestId('e').getAttribute('data-active')).toBe('true');
    fireEvent.click(screen.getByText('mainContent.resetLayout'));
    expect(useTerminalLayoutStore.getState().columns).toBe(50);
    fireEvent.click(screen.getByText('mainContent.single'));
    expect(mounts.count).toBe(5);
    expect(screen.getByTestId('a').getAttribute('data-visible')).toBe('false');
  });
  it('focuses the clicked pane and active session', () => {
    render(<MainContent />);
    fireEvent.click(screen.getByText('mainContent.split'));
    fireEvent.pointerDown(screen.getByTestId('b'));
    expect(useTerminalStore.getState().activeTabId).toBe('b');
    expect(screen.getByTestId('b').getAttribute('data-active')).toBe('true');
  });
});
