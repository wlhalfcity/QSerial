/**
 * FTP 客户端面板：连接远端 FTP 服务器，浏览文件列表，拖拽上传 / 双击下载。
 * 挂载于 Layout 最右侧，与智能助手面板互斥（见 stores/ftpClient.ts）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FtpClientFileInfo } from '@qserial/shared';
import { useFtpClientStore } from '@/stores/ftpClient';

const PANEL_WIDTH = 360;

const IconFolder: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    className="text-primary flex-shrink-0"
  >
    <path
      d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12v-8.5z"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const IconFile: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    className="text-text-secondary flex-shrink-0"
  >
    <path
      d="M4 1.5h5L12.5 5v9A.5.5 0 0 1 12 14.5H4a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z M9 1.5V5h3.5"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const FileIcon: React.FC<{ file: FtpClientFileInfo }> = ({ file }) =>
  file.type === 'directory' ? <IconFolder /> : <IconFile />;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const FtpClientPanel: React.FC = () => {
  const { t } = useTranslation();
  const panelOpen = useFtpClientStore((s) => s.panelOpen);
  const session = useFtpClientStore((s) => s.session);
  const connecting = useFtpClientStore((s) => s.connecting);
  const transfers = useFtpClientStore((s) => s.transfers);
  const closePanel = useFtpClientStore((s) => s.closePanel);
  const connect = useFtpClientStore((s) => s.connect);
  const disconnect = useFtpClientStore((s) => s.disconnect);
  const navigateTo = useFtpClientStore((s) => s.navigateTo);
  const goUp = useFtpClientStore((s) => s.goUp);
  const refresh = useFtpClientStore((s) => s.refresh);
  const mkdir = useFtpClientStore((s) => s.mkdir);
  const rm = useFtpClientStore((s) => s.rm);
  const downloadFile = useFtpClientStore((s) => s.downloadFile);
  const uploadPaths = useFtpClientStore((s) => s.uploadPaths);
  const updateProgress = useFtpClientStore((s) => s.updateProgress);

  const [host, setHost] = useState('');
  const [port, setPort] = useState('21');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const dragCounterRef = useRef(0);

  // 传输进度事件 → store
  useEffect(() => {
    const off = window.qserial.ftpClient.onProgress(updateProgress);
    return off;
  }, [updateProgress]);

  if (!panelOpen) return null;

  const runningTransfer = [...transfers].reverse().find((x) => x.status === 'running');

  const handleConnect = async () => {
    if (!host.trim()) return;
    await connect({ host: host.trim(), port: Number(port) || 21, user: user.trim(), password });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.qserial.pathForFile(f))
      .filter(Boolean);
    if (paths.length > 0) void uploadPaths(paths);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (session) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) setDragOver(false);
  };

  const handleDoubleClick = async (file: FtpClientFileInfo) => {
    if (file.type === 'directory') {
      const base = session?.currentPath ?? '/';
      const target = base.endsWith('/') ? `${base}${file.name}` : `${base}/${file.name}`;
      await navigateTo(target);
    } else {
      const dir = await window.qserial.sftp.pickLocalDir();
      if (dir) await downloadFile(file, dir);
    }
  };

  const breadcrumbs: Array<{ name: string; path: string }> = [];
  if (session) {
    breadcrumbs.push({ name: '/', path: '/' });
    const segments = session.currentPath.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc += `/${seg}`;
      breadcrumbs.push({ name: seg, path: acc });
    }
  }

  const renderRunningTransfer = () => {
    if (!runningTransfer) return null;
    return (
      <div className="px-3 py-1.5 border-t border-border flex-shrink-0">
        <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
          <span className="truncate">
            {runningTransfer.operation === 'upload' ? '↑' : '↓'}{' '}
            {runningTransfer.remotePath.split('/').pop()}
          </span>
          <span>
            {runningTransfer.percent}% · {formatSize(runningTransfer.transferred)}/
            {formatSize(runningTransfer.total)}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-hover overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${runningTransfer.percent}%` }}
          />
        </div>
      </div>
    );
  };

  return (
    <div
      className="relative flex-shrink-0 border-l border-border bg-surface flex flex-col min-h-0"
      style={{ width: PANEL_WIDTH }}
      onDragEnter={handleDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">
          {session
            ? `${session.host}${session.user ? ` · ${session.user}` : ''}`
            : t('ftpClient.title')}
        </span>
        <button
          onClick={() => (session ? void disconnect() : closePanel())}
          className="dialog-btn dialog-btn-secondary text-xs px-2 py-1"
        >
          {session ? t('ftpClient.disconnect') : t('common.close')}
        </button>
      </div>

      {!session ? (
        /* 连接表单 */
        <div className="flex-1 flex flex-col justify-center px-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t('ftpClient.host')}
            </label>
            <input
              className="dialog-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100"
              onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t('ftpClient.port')}
            </label>
            <input
              className="dialog-input"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t('ftpClient.user')}
            </label>
            <input
              className="dialog-input"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={t('ftpClient.userHint')}
              onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t('ftpClient.password')}
            </label>
            <input
              type="password"
              className="dialog-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
            />
          </div>
          {session?.error && <div className="text-xs text-error">{session.error}</div>}
          <button
            onClick={() => void handleConnect()}
            disabled={connecting || !host.trim()}
            className="dialog-btn dialog-btn-primary disabled:opacity-50"
          >
            {connecting ? t('common.loading') : t('ftpClient.connect')}
          </button>
        </div>
      ) : (
        <>
          {/* 工具行 */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border flex-shrink-0">
            <button
              onClick={() => void goUp()}
              disabled={session.currentPath === '/'}
              className="dialog-btn dialog-btn-secondary text-xs px-2 py-1 disabled:opacity-40"
              title=".."
            >
              ↑
            </button>
            <button
              onClick={() => void refresh()}
              className="dialog-btn dialog-btn-secondary text-xs px-2 py-1"
            >
              {t('ftpClient.refresh')}
            </button>
            <button
              onClick={() => {
                setCreatingFolder(true);
                setNewFolderName('');
              }}
              className="dialog-btn dialog-btn-secondary text-xs px-2 py-1"
            >
              {t('ftpClient.newFolder')}
            </button>
            <div className="ml-auto text-xs text-text-secondary truncate">
              {t('ftpClient.dropHint')}
            </div>
          </div>

          {/* 新建文件夹输入行 */}
          {creatingFolder && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border flex-shrink-0">
              <input
                autoFocus
                className="dialog-input text-xs flex-1"
                value={newFolderName}
                placeholder={t('ftpClient.newFolderPlaceholder')}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && newFolderName.trim()) {
                    await mkdir(newFolderName.trim());
                    setCreatingFolder(false);
                  }
                  if (e.key === 'Escape') setCreatingFolder(false);
                }}
              />
              <button
                onClick={async () => {
                  if (newFolderName.trim()) await mkdir(newFolderName.trim());
                  setCreatingFolder(false);
                }}
                className="dialog-btn dialog-btn-primary text-xs px-2 py-1"
              >
                {t('common.confirm')}
              </button>
            </div>
          )}

          {/* 面包屑 */}
          <div className="flex items-center px-2 h-6 border-b border-border text-xs overflow-x-auto flex-shrink-0">
            {breadcrumbs.map((crumb, i) => (
              <React.Fragment key={crumb.path}>
                {i > 0 && <span className="px-0.5 text-text-secondary">/</span>}
                <button
                  onClick={() => void navigateTo(crumb.path)}
                  className={`px-1 py-0.5 rounded hover:bg-hover transition-colors whitespace-nowrap ${
                    i === breadcrumbs.length - 1
                      ? 'text-text'
                      : 'text-text-secondary hover:text-text'
                  }`}
                >
                  {crumb.name}
                </button>
              </React.Fragment>
            ))}
          </div>

          {/* 表头 */}
          <div className="flex items-center px-2 h-6 border-b border-border text-xs text-text-secondary flex-shrink-0 select-none">
            <span className="flex-1 min-w-0">{t('ftpClient.name')}</span>
            <span className="w-16 text-right">{t('ftpClient.size')}</span>
            <span className="w-28 text-right">{t('ftpClient.modified')}</span>
          </div>

          {/* 文件列表 */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {session.loading ? (
              <div className="flex items-center justify-center h-20 text-text-secondary text-xs">
                {t('common.loading')}
              </div>
            ) : session.error ? (
              <div className="flex items-center justify-center h-20 text-error text-xs px-2 text-center">
                {session.error}
              </div>
            ) : session.files.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-text-secondary text-xs">
                {t('ftpClient.emptyDir')}
              </div>
            ) : (
              <div className="py-0.5">
                {session.files.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-hover border-l-2 border-transparent transition-colors"
                    onDoubleClick={() => void handleDoubleClick(file)}
                    title={
                      file.type === 'file' ? t('ftpClient.downloadTip') : t('ftpClient.openTip')
                    }
                  >
                    <FileIcon file={file} />
                    <span className="flex-1 text-xs truncate">{file.name}</span>
                    <span className="text-xs text-text-secondary w-16 text-right flex-shrink-0">
                      {file.type === 'file' ? formatSize(file.size) : ''}
                    </span>
                    <span className="text-xs text-text-secondary w-28 text-right flex-shrink-0">
                      {formatTime(file.modifyTime)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void rm(file);
                      }}
                      className="text-text-secondary hover:text-error text-xs px-1 flex-shrink-0"
                      title={t('ftpClient.delete')}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 拖拽覆盖提示 */}
          {dragOver && (
            <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary flex items-center justify-center pointer-events-none">
              <span className="text-sm text-primary font-medium">
                {t('ftpClient.dropToUpload')}
              </span>
            </div>
          )}
        </>
      )}

      {/* 传输进度 */}
      {renderRunningTransfer()}
    </div>
  );
};
