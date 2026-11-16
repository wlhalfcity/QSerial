/**
 * FTP 客户端面板：连接远端 FTP 服务器，浏览文件列表，拖拽上传 / 双击下载。
 * 挂载于 Layout 最右侧，与智能助手面板互斥（见 stores/ftpClient.ts）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FtpClientFileInfo } from '@qserial/shared';
import { useFtpClientStore } from '@/stores/ftpClient';

import { globalError } from '../common/ErrorToast';
import { useFtpProfiles } from '@/stores/ftpProfiles';
const PANEL_WIDTH = 560;

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
  const downloadFile = useFtpClientStore((s) => s.downloadFile);
  const uploadPaths = useFtpClientStore((s) => s.uploadPaths);
  const updateProgress = useFtpClientStore((s) => s.updateProgress);

  const { profiles, save, remove } = useFtpProfiles();
  const switchingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
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

  const validForm = () => {
    const n = Number(port);
    if (!host.trim() || !Number.isInteger(n) || n < 1 || n > 65535) {
      globalError.show(t('ftpClient.invalidProfile'));
      return null;
    }
    return { host: host.trim(), port: n, user, password };
  };
  const connectForm = async (form: {
    host: string;
    port: number;
    user: string;
    password: string;
  }) => {
    if (
      switchingRef.current ||
      useFtpClientStore.getState().connecting ||
      useFtpClientStore.getState().transfers.some((x) => x.status === 'running')
    ) {
      globalError.show(t('ftpClient.connectionBusy'));
      return;
    }
    if (useFtpClientStore.getState().session && !window.confirm(t('ftpClient.switchConfirm')))
      return;
    switchingRef.current = true;
    try {
      if (useFtpClientStore.getState().session) await disconnect();
      if (await connect(form)) setEditing(false);
    } finally {
      switchingRef.current = false;
    }
  };
  const handleConnect = async () => {
    const form = validForm();
    if (form) await connectForm(form);
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
      className="relative flex-shrink-0 border-l border-border bg-surface flex min-h-0"
      style={{ width: PANEL_WIDTH, maxWidth: '75vw' }}
      onDragEnter={handleDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <aside
        className="w-40 shrink-0 border-r border-border flex flex-col overflow-y-auto p-2 gap-2"
        aria-label={t('ftpClient.savedConnections')}
      >
        <h3 className="text-xs font-medium">{t('ftpClient.savedConnections')}</h3>
        <button
          className="text-xs border border-border rounded px-2 py-1"
          onClick={() => {
            setProfileId('');
            setProfileName('');
            setHost('');
            setPort('21');
            setUser('');
            setPassword('');
            setEditing(true);
          }}
        >
          {t('ftpClient.newProfile')}
        </button>
        {profiles.length === 0 && (
          <span className="text-xs text-text-secondary">{t('ftpClient.noProfiles')}</span>
        )}
        {profiles.map((p) => (
          <div
            key={p.id}
            className="border border-border rounded p-1 text-xs"
            onDoubleClick={() => void connectForm(p)}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && e.key === 'Enter') void connectForm(p);
            }}
            tabIndex={0}
          >
            <span className="block break-all">
              {p.name} · {p.user}@{p.host}:{p.port}
            </span>
            <button
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => {
                setEditing(true);
                setProfileId(p.id);
                setProfileName(p.name);
                setHost(p.host);
                setPort(String(p.port));
                setUser(p.user);
                setPassword(p.password);
              }}
            >
              {t('ftpClient.editProfile')}
            </button>
            <button
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => {
                if (window.confirm(t('ftpClient.deleteConfirm'))) {
                  remove(p.id);
                  if (profileId === p.id) {
                    setProfileId('');
                    setEditing(false);
                  }
                }
              }}
            >
              {t('ftpClient.deleteProfile')}
            </button>
          </div>
        ))}
      </aside>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col relative">
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

        {!session || editing ? (
          /* 连接表单 */
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col px-5 py-4 gap-3">
            <input
              className="dialog-input"
              value={profileName}
              placeholder={t('ftpClient.profileName')}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <button
              onClick={() => {
                const form = validForm();
                if (!form) return;
                const id = profileId || crypto.randomUUID();
                save({ ...form, id, name: profileName.trim() || `${form.host}:${form.port}` });
                setProfileId(id);
                if (session) setEditing(false);
              }}
            >
              {t('ftpClient.saveProfile')}
            </button>
            {session && <button onClick={() => setEditing(false)}>{t('common.cancel')}</button>}
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
    </div>
  );
};
