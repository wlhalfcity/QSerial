import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '@/stores/terminal';
import { TerminalPane } from '../terminal/TerminalPane';
import { SftpPanel } from '../sftp';
import { useSftpStore } from '@/stores/sftp';

import { useTerminalLayoutStore, paneBounds } from '@/stores/terminal-layout';

export const MainContent: React.FC = () => {
  const layout = useTerminalLayoutStore();
  const { split, visible, columns, rows } = layout;
  const dragged = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const { panelVisible } = useSftpStore();

  const ids = useMemo(() => tabs.flatMap((tab) => tab.sessions), [tabs]);
  const activeId = tabs.find((tab) => tab.id === activeTabId)?.activeSessionId;
  const syncLayout = layout.sync;
  useEffect(() => {
    syncLayout(ids, activeId || null);
  }, [ids, activeId, split, syncLayout]);
  const resize = (axis: 'columns' | 'rows', event: React.PointerEvent<HTMLDivElement>) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio =
      axis === 'columns'
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height;
    layout.resize(axis, ratio * 100);
  };
  const renderPanes = () => {
    const panes: React.ReactNode[] = [];
    const sessions = useTerminalStore.getState().sessions;
    for (const tab of tabs) {
      for (const sessionId of tab.sessions) {
        const session = sessions[sessionId];
        if (!session) continue;
        panes.push(
          <div
            key={sessionId}
            className={`absolute overflow-hidden ${sessionId === activeId && split ? 'ring-1 ring-inset ring-primary' : ''}`}
            style={
              split && visible.includes(sessionId)
                ? paneBounds(visible.indexOf(sessionId), visible.length, columns, rows)
                : { inset: 0, visibility: !split && sessionId === activeId ? 'visible' : 'hidden' }
            }
            onPointerDownCapture={() => useTerminalStore.getState().focusSession(sessionId)}
          >
            {split && visible.includes(sessionId) && (
              <div
                draggable
                onDragStart={() => {
                  dragged.current = sessionId;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragged.current) layout.swap(dragged.current, sessionId);
                  dragged.current = null;
                }}
                className="absolute top-0 left-0 right-0 h-6 z-20 bg-surface border border-border text-xs cursor-move px-2 truncate"
              >
                {session.name}
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0" style={{ top: split ? 24 : 0 }}>
              <TerminalPane
                key={sessionId}
                sessionId={sessionId}
                connectionId={session.connectionId}
                isActive={sessionId === activeId}
                isVisible={split ? visible.includes(sessionId) : sessionId === activeId}
                activeTabId={activeTabId}
              />
            </div>
          </div>
        );
      }
    }
    return panes;
  };

  return (
    <div className="flex-1 min-h-0 bg-background flex main-content-container">
      <div className="flex-1 min-h-0 bg-background flex flex-col">
        {tabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center px-8">
            <div className="flex flex-col items-center">
              <svg
                width="56"
                height="46"
                viewBox="0 0 72 58"
                fill="none"
                className="text-primary mb-4"
                aria-label="QSerial"
              >
                <path
                  d="M12 14l12 16L12 46"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M30 46h28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              <h1 className="text-xl font-semibold text-text tracking-tight">QSerial</h1>
              <p className="text-xs text-text-secondary/50 mt-0.5">
                {t('mainContent.embeddedTool')}
              </p>

              <div className="w-[280px] mt-10 space-y-4">
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('qserial:open-pty'))}
                  className="w-full bg-background/60 border border-primary/20 rounded-lg overflow-hidden hover:border-primary/40 hover:bg-primary/[0.04] transition-all active:scale-[0.99] group"
                >
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-primary flex-shrink-0"
                    >
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <polyline points="7 10 10 13 7 16" />
                    </svg>
                    <span className="text-sm font-medium text-primary">
                      {t('sidebar.localTerminal')}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-primary/40 ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <path d="M4 2l4 4-4 4" />
                    </svg>
                  </div>
                </button>

                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('qserial:open-serial'))}
                  className="w-full bg-background/60 border border-border/30 rounded-lg overflow-hidden hover:border-border/50 hover:bg-hover/50 transition-all active:scale-[0.99] group"
                >
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-text-secondary flex-shrink-0 group-hover:text-text transition-colors"
                    >
                      <path d="M4 7V5a2 2 0 012-2h12a2 2 0 012 2v2" />
                      <rect x="3" y="9" width="18" height="10" rx="2" />
                      <line x1="12" y1="14" x2="12" y2="18" />
                      <line x1="10" y1="16" x2="14" y2="16" />
                    </svg>
                    <span className="text-sm text-text-secondary group-hover:text-text transition-colors">
                      {t('sidebar.serialConnect')}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-text-secondary/30 ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <path d="M4 2l4 4-4 4" />
                    </svg>
                  </div>
                </button>

                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('qserial:open-ssh'))}
                  className="w-full bg-background/60 border border-border/30 rounded-lg overflow-hidden hover:border-border/50 hover:bg-hover/50 transition-all active:scale-[0.99] group"
                >
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-text-secondary flex-shrink-0 group-hover:text-text transition-colors"
                    >
                      <rect x="2" y="4" width="20" height="16" rx="3" />
                      <path d="M8 14l.5.5a2 2 0 003 0L12 14l1.5-1.5a2 2 0 013 0l.5.5" />
                      <circle cx="12" cy="12" r="2" />
                    </svg>
                    <span className="text-sm text-text-secondary group-hover:text-text transition-colors">
                      {t('sidebar.sshConnect')}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-text-secondary/30 ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <path d="M4 2l4 4-4 4" />
                    </svg>
                  </div>
                </button>

                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('qserial:open-telnet'))}
                  className="w-full bg-background/60 border border-border/30 rounded-lg overflow-hidden hover:border-border/50 hover:bg-hover/50 transition-all active:scale-[0.99] group"
                >
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-text-secondary flex-shrink-0 group-hover:text-text transition-colors"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M12 2v6M12 16v6M2 12h6M16 12h6" />
                    </svg>
                    <span className="text-sm text-text-secondary group-hover:text-text transition-colors">
                      {t('sidebar.telnetConnect')}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className="text-text-secondary/30 ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <path d="M4 2l4 4-4 4" />
                    </svg>
                  </div>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex shrink-0 gap-3 px-2 py-1 border-b border-border text-xs">
              <button onClick={() => layout.toggle(ids, activeId || null)}>
                {t(split ? 'mainContent.single' : 'mainContent.split')}
              </button>
              {split && (
                <button onClick={() => layout.reset(ids, activeId || null)}>
                  {t('mainContent.resetLayout')}
                </button>
              )}
            </div>
            <div ref={gridRef} className="flex-1 min-h-0 relative overflow-hidden bg-background">
              {renderPanes()}
              {split && visible.length > 1 && (
                <div
                  role="separator"
                  aria-label={t('mainContent.columnDivider')}
                  aria-orientation="vertical"
                  tabIndex={0}
                  className="absolute inset-y-0 w-1 z-30 cursor-col-resize bg-border hover:bg-primary touch-none"
                  style={{ left: `calc(${columns}% - 2px)` }}
                  onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                  onPointerMove={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) resize('columns', e);
                  }}
                  onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                      e.preventDefault();
                      layout.resize('columns', columns + (e.key === 'ArrowLeft' ? -2 : 2));
                    }
                  }}
                />
              )}
              {split && visible.length > 2 && (
                <div
                  role="separator"
                  aria-label={t('mainContent.rowDivider')}
                  aria-orientation="horizontal"
                  tabIndex={0}
                  className="absolute right-0 h-1 z-30 cursor-row-resize bg-border hover:bg-primary touch-none"
                  style={{
                    top: `calc(${rows}% - 2px)`,
                    left: visible.length === 3 ? `${columns}%` : 0,
                  }}
                  onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                  onPointerMove={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) resize('rows', e);
                  }}
                  onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      layout.resize('rows', rows + (e.key === 'ArrowUp' ? -2 : 2));
                    }
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {panelVisible && <SftpPanel />}
    </div>
  );
};
