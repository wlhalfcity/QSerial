/**
 * FTP 客户端管理器
 * 基于 basic-ftp 连接远端 FTP 服务器，提供文件浏览、上传下载与基础文件操作。
 * 传输使用独立临时连接（basic-ftp 单连接不支持并发，传输与浏览互不阻塞），
 * 进度经 ftpClient:progressEvent 推送到渲染进程。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'basic-ftp';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@qserial/shared';
import type { FtpClientFileInfo, FtpClientProgressEvent } from '@qserial/shared';

const CONNECT_TIMEOUT_MS = 20000;
const TRANSFER_TIMEOUT_MS = 120000;

interface FtpClientSession {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  /** 控制连接：用于 list 等浏览操作 */
  client: Client;
}

const sessions = new Map<string, FtpClientSession>();
let mainWindow: BrowserWindow | null = null;

export function setFtpClientMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

function sendProgressEvent(event: FtpClientProgressEvent): void {
  mainWindow?.webContents.send(IPC_CHANNELS.FTP_CLIENT_PROGRESS_EVENT, event);
}

function getSession(clientId: string): FtpClientSession {
  const session = sessions.get(clientId);
  if (!session) throw new Error(`FTP 会话不存在: ${clientId.slice(0, 8)}`);
  return session;
}

/** 建立独立连接（同一凭证），供单次传输使用 */
async function openTransferConnection(session: FtpClientSession): Promise<Client> {
  const client = new Client(TRANSFER_TIMEOUT_MS);
  await client.access({
    host: session.host,
    port: session.port,
    user: session.user,
    password: session.password,
    secure: session.secure,
  });
  return client;
}

function trackProgress(
  client: Client,
  clientId: string,
  operation: 'download' | 'upload',
  localPath: string,
  remotePath: string,
  total: number
): void {
  client.trackProgress((info) => {
    if (info.type === 'list') return;
    const transferred = info.bytes ?? 0;
    sendProgressEvent({
      clientId,
      operation,
      localPath,
      remotePath,
      total,
      transferred,
      percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
    });
  });
}

export async function createClient(opts: {
  host: string;
  port?: number;
  user?: string;
  password?: string;
}): Promise<{ clientId: string }> {
  const host = opts.host?.trim();
  if (!host) throw new Error('FTP 主机不能为空');
  const user = opts.user?.trim() || 'anonymous';
  const password = opts.password ?? 'guest';

  const client = new Client(CONNECT_TIMEOUT_MS);
  try {
    await client.access({ host, port: opts.port ?? 21, user, password, secure: false });
  } catch (err) {
    client.close();
    throw err;
  }

  const id = `ftpcli-${randomUUID()}`;
  sessions.set(id, {
    id,
    host,
    port: opts.port ?? 21,
    user,
    password,
    secure: false,
    client,
  });
  return { clientId: id };
}

export async function listDir(clientId: string, remotePath: string): Promise<FtpClientFileInfo[]> {
  const session = getSession(clientId);
  const list = await session.client.list(remotePath);
  const mapped: FtpClientFileInfo[] = list.map((f) => ({
    name: f.name,
    type: f.isDirectory ? 'directory' : f.isSymbolicLink ? 'symlink' : 'file',
    size: typeof f.size === 'number' ? f.size : 0,
    modifyTime: f.modifiedAt instanceof Date ? f.modifiedAt.getTime() : 0,
  }));
  mapped.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return mapped;
}

export async function downloadFile(
  clientId: string,
  remotePath: string,
  localPath: string
): Promise<void> {
  const session = getSession(clientId);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const transfer = await openTransferConnection(session);
  try {
    // ProgressInfo 不含总大小，用 SIZE 命令预先查询
    let total = 0;
    try {
      total = await transfer.size(remotePath);
    } catch {
      /* 部分服务器不支持 SIZE，退化为无百分比进度 */
    }
    trackProgress(transfer, clientId, 'download', localPath, remotePath, total);
    await transfer.downloadTo(localPath, remotePath);
  } finally {
    transfer.close();
  }
}

export async function uploadFile(
  clientId: string,
  localPath: string,
  remotePath: string
): Promise<void> {
  const session = getSession(clientId);
  const total = fs.statSync(localPath).size;
  const transfer = await openTransferConnection(session);
  try {
    trackProgress(transfer, clientId, 'upload', localPath, remotePath, total);
    await transfer.uploadFrom(localPath, remotePath);
  } finally {
    transfer.close();
  }
}

export async function mkdir(clientId: string, remotePath: string): Promise<void> {
  await getSession(clientId).client.ensureDir(remotePath);
}

export async function removeDir(clientId: string, remotePath: string): Promise<void> {
  await getSession(clientId).client.removeDir(remotePath);
}

export async function removeFile(clientId: string, remotePath: string): Promise<void> {
  await getSession(clientId).client.remove(remotePath);
}

export async function rename(clientId: string, fromPath: string, toPath: string): Promise<void> {
  await getSession(clientId).client.rename(fromPath, toPath);
}

export async function destroyClient(clientId: string): Promise<void> {
  const session = sessions.get(clientId);
  if (!session) return;
  sessions.delete(clientId);
  try {
    session.client.close();
  } catch {
    /* ignore */
  }
}

export function destroyAllManager(): void {
  for (const [, session] of sessions) {
    try {
      session.client.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
