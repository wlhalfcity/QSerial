/**
 * FTP 客户端状态管理
 * 单会话模型（一个面板一个连接），仿 stores/sftp.ts 的 sessions/transfers 模式。
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { FtpClientFileInfo, FtpClientProgressEvent } from '@qserial/shared';
import { useAssistantStore } from './assistant';

export interface FtpClientConnectForm {
  host: string;
  port: number;
  user: string;
  password: string;
}

interface TransferTask {
  id: string;
  operation: 'upload' | 'download';
  localPath: string;
  remotePath: string;
  total: number;
  transferred: number;
  percent: number;
  status: 'running' | 'completed' | 'error';
  error?: string;
}

interface FtpClientSessionState {
  clientId: string;
  host: string;
  port: number;
  user: string;
  currentPath: string;
  files: FtpClientFileInfo[];
  loading: boolean;
  error: string | null;
}

interface FtpClientState {
  panelOpen: boolean;
  connecting: boolean;
  session: FtpClientSessionState | null;
  transfers: TransferTask[];

  openPanel: () => void;
  closePanel: () => void;
  connect: (form: FtpClientConnectForm) => Promise<boolean>;
  disconnect: () => Promise<void>;
  navigateTo: (path: string) => Promise<void>;
  goUp: () => Promise<void>;
  refresh: () => Promise<void>;
  mkdir: (name: string) => Promise<void>;
  rm: (file: FtpClientFileInfo) => Promise<void>;
  downloadFile: (file: FtpClientFileInfo, localDir: string) => Promise<void>;
  uploadPaths: (localPaths: string[]) => Promise<void>;
  updateProgress: (event: FtpClientProgressEvent) => void;
}

const parentPath = (p: string): string => {
  if (!p || p === '/') return '/';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
};

const joinPath = (dir: string, name: string): string =>
  dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;

export const useFtpClientStore = create<FtpClientState>()(
  immer((set, get) => ({
    panelOpen: false,
    connecting: false,
    session: null,
    transfers: [],

    openPanel: () => {
      // 与智能助手面板互斥，避免两个右侧面板同时挤压主区
      useAssistantStore.getState().closePanel();
      set((state) => {
        state.panelOpen = true;
      });
    },

    closePanel: () => {
      set((state) => {
        state.panelOpen = false;
      });
    },

    connect: async (form) => {
      set((state) => {
        state.connecting = true;
      });
      try {
        const { clientId } = await window.qserial.ftpClient.create(form);
        set((state) => {
          state.session = {
            clientId,
            host: form.host,
            port: form.port,
            user: form.user || 'anonymous',
            currentPath: '/',
            files: [],
            loading: true,
            error: null,
          };
        });
        // FTP 登录后的起始目录由服务端决定，尝试列根目录
        await get().navigateTo('/');
        return true;
      } catch (error) {
        set((state) => {
          if (state.session) {
            state.session.error = (error as Error).message;
          }
        });
        return false;
      } finally {
        set((state) => {
          state.connecting = false;
        });
      }
    },

    disconnect: async () => {
      const session = get().session;
      if (session) {
        await window.qserial.ftpClient.destroy(session.clientId).catch(() => {});
      }
      set((state) => {
        state.session = null;
        state.transfers = [];
      });
    },

    navigateTo: async (path) => {
      const session = get().session;
      if (!session) return;
      set((state) => {
        if (state.session) {
          state.session.loading = true;
          state.session.error = null;
        }
      });
      try {
        const files = await window.qserial.ftpClient.list(session.clientId, path);
        set((state) => {
          if (state.session) {
            state.session.currentPath = path;
            state.session.files = files;
            state.session.loading = false;
          }
        });
      } catch (error) {
        set((state) => {
          if (state.session) {
            state.session.loading = false;
            state.session.error = (error as Error).message;
            // 目录打开失败（无权限等）：回退上一级避免停留在无效路径
            state.session.currentPath = parentPath(session.currentPath);
          }
        });
      }
    },

    goUp: async () => {
      const session = get().session;
      if (!session || session.currentPath === '/') return;
      await get().navigateTo(parentPath(session.currentPath));
    },

    refresh: async () => {
      const session = get().session;
      if (!session) return;
      await get().navigateTo(session.currentPath);
    },

    mkdir: async (name) => {
      const session = get().session;
      if (!session || !name.trim()) return;
      await window.qserial.ftpClient.mkdir(
        session.clientId,
        joinPath(session.currentPath, name.trim())
      );
      await get().refresh();
    },

    rm: async (file) => {
      const session = get().session;
      if (!session) return;
      const target = joinPath(session.currentPath, file.name);
      if (file.type === 'directory') {
        await window.qserial.ftpClient.rmdir(session.clientId, target);
      } else {
        await window.qserial.ftpClient.rm(session.clientId, target);
      }
      await get().refresh();
    },

    downloadFile: async (file, localDir) => {
      const session = get().session;
      if (!session) return;
      const remotePath = joinPath(session.currentPath, file.name);
      const localPath = `${localDir.replace(/[\\/]+$/, '')}/${file.name}`;
      const taskId = crypto.randomUUID();

      set((state) => {
        state.transfers.push({
          id: taskId,
          operation: 'download',
          localPath,
          remotePath,
          total: file.size,
          transferred: 0,
          percent: 0,
          status: 'running',
        });
        state.transfers = state.transfers.slice(-50);
      });

      try {
        await window.qserial.ftpClient.download(session.clientId, remotePath, localPath);
        set((state) => {
          const task = state.transfers.find((t) => t.id === taskId);
          if (task) {
            task.status = 'completed';
            task.percent = 100;
          }
        });
      } catch (error) {
        set((state) => {
          const task = state.transfers.find((t) => t.id === taskId);
          if (task) {
            task.status = 'error';
            task.error = (error as Error).message;
          }
        });
      }
    },

    uploadPaths: async (localPaths) => {
      const session = get().session;
      if (!session || localPaths.length === 0) return;
      for (const localPath of localPaths) {
        const name = localPath.split(/[\\/]/).pop() || 'file';
        const remotePath = joinPath(session.currentPath, name);
        const taskId = crypto.randomUUID();

        set((state) => {
          state.transfers.push({
            id: taskId,
            operation: 'upload',
            localPath,
            remotePath,
            total: 0,
            transferred: 0,
            percent: 0,
            status: 'running',
          });
          state.transfers = state.transfers.slice(-50);
        });

        try {
          await window.qserial.ftpClient.upload(session.clientId, localPath, remotePath);
          set((state) => {
            const task = state.transfers.find((t) => t.id === taskId);
            if (task) {
              task.status = 'completed';
              task.percent = 100;
            }
          });
        } catch (error) {
          set((state) => {
            const task = state.transfers.find((t) => t.id === taskId);
            if (task) {
              task.status = 'error';
              task.error = (error as Error).message;
            }
          });
        }
      }
      await get().refresh();
    },

    updateProgress: (event) => {
      set((state) => {
        const task = state.transfers.find(
          (t) =>
            t.remotePath === event.remotePath &&
            t.operation === event.operation &&
            t.status === 'running'
        );
        if (task) {
          task.total = event.total;
          task.transferred = event.transferred;
          task.percent = event.percent;
        }
      });
    },
  }))
);
