/** @vitest-environment jsdom */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FtpClientPanel } from '../../src/components/ftpClient/FtpClientPanel';
import { useFtpClientStore } from '../../src/stores/ftpClient';
import { useFtpProfiles } from '../../src/stores/ftpProfiles';
vi.mock('../../src/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/components/common/ErrorToast', () => ({ globalError: { show: vi.fn() } }));
const profile = {
  id: 'one',
  name: 'Server',
  host: '127.0.0.1',
  port: 2121,
  user: 'admin',
  password: ' secret ',
};
const connect = vi.fn(async () => true);
const disconnect = vi.fn(async () => {});
describe('FTP saved connections', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(window, 'qserial', {
      configurable: true,
      value: { ftpClient: { onProgress: () => () => {} } },
    });
    useFtpProfiles.setState({ profiles: [profile] });
    useFtpClientStore.setState({
      panelOpen: true,
      session: null,
      connecting: false,
      transfers: [],
      connect,
      disconnect,
    });
  });
  it('persists passwords exactly and updates by id without duplicates', async () => {
    useFtpProfiles.getState().save({ ...profile, name: 'Updated' });
    expect(useFtpProfiles.getState().profiles).toHaveLength(1);
    const persisted = localStorage.getItem('qserial_ftp_profiles') || '';
    useFtpProfiles.setState({ profiles: [] });
    localStorage.setItem('qserial_ftp_profiles', persisted);
    await useFtpProfiles.persist.rehydrate();
    expect(useFtpProfiles.getState().profiles[0]).toMatchObject({
      password: ' secret ',
      name: 'Updated',
    });
    useFtpProfiles.getState().remove(profile.id);
    expect(useFtpProfiles.getState().profiles).toEqual([]);
  });
  it('connects using saved parameters on double click', async () => {
    render(<FtpClientPanel />);
    fireEvent.doubleClick(screen.getByText(/Server ·/));
    await waitFor(() => expect(connect).toHaveBeenCalledWith(profile));
  });
  it('does not switch while connecting or transferring', () => {
    useFtpClientStore.setState({ connecting: true });
    render(<FtpClientPanel />);
    fireEvent.doubleClick(screen.getByText(/Server ·/));
    expect(connect).not.toHaveBeenCalled();
    act(() =>
      useFtpClientStore.setState({
        connecting: false,
        transfers: [
          {
            id: 't',
            status: 'running',
            operation: 'upload',
            remotePath: '/file',
            localPath: '/file',
            percent: 0,
            total: 1,
            transferred: 0,
          },
        ],
      })
    );
    fireEvent.doubleClick(screen.getByText(/Server ·/));
    expect(connect).not.toHaveBeenCalled();
  });
  it('allows editing without connecting and keeps password masked', () => {
    render(<FtpClientPanel />);
    fireEvent.click(screen.getByText('ftpClient.editProfile'));
    expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe(
      ' secret '
    );
    fireEvent.click(screen.getByText('ftpClient.saveProfile'));
    expect(useFtpProfiles.getState().profiles).toHaveLength(1);
    expect(connect).not.toHaveBeenCalled();
  });
  it('confirms deletion and can cancel', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<FtpClientPanel />);
    fireEvent.click(screen.getByText('ftpClient.deleteProfile'));
    expect(useFtpProfiles.getState().profiles).toHaveLength(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('ftpClient.deleteProfile'));
    expect(useFtpProfiles.getState().profiles).toEqual([]);
    confirm.mockRestore();
  });
  it('validates ports and retains the exact saved password', () => {
    render(<FtpClientPanel />);
    fireEvent.click(screen.getByText('ftpClient.editProfile'));
    fireEvent.change(screen.getByDisplayValue('2121'), { target: { value: '65536' } });
    fireEvent.click(screen.getByText('ftpClient.saveProfile'));
    expect(useFtpProfiles.getState().profiles[0].port).toBe(2121);
    fireEvent.change(screen.getByDisplayValue('65536'), { target: { value: '21' } });
    fireEvent.click(screen.getByText('ftpClient.saveProfile'));
    expect(useFtpProfiles.getState().profiles[0]).toMatchObject({ port: 21, password: ' secret ' });
  });
  it('confirms connection switching and honors cancellation', async () => {
    useFtpClientStore.setState({
      session: {
        clientId: 'old',
        host: 'old',
        port: 21,
        user: 'a',
        currentPath: '/',
        files: [],
        loading: false,
        error: null,
      },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<FtpClientPanel />);
    fireEvent.doubleClick(screen.getByText(/Server ·/));
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.doubleClick(screen.getByText(/Server ·/));
    await waitFor(() => expect(connect).toHaveBeenCalledWith(profile));
    expect(disconnect).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });
  it('keeps saved connection on login failure', async () => {
    connect.mockResolvedValueOnce(false);
    render(<FtpClientPanel />);
    fireEvent.doubleClick(screen.getByText(/Server ·/));
    await waitFor(() => expect(connect).toHaveBeenCalled());
    expect(useFtpProfiles.getState().profiles).toEqual([profile]);
  });
});
