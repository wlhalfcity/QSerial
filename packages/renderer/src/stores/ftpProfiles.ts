import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FtpClientConnectForm } from './ftpClient';
export interface FtpProfile extends FtpClientConnectForm {
  id: string;
  name: string;
}
export const useFtpProfiles = create<{
  profiles: FtpProfile[];
  save: (p: FtpProfile) => void;
  remove: (id: string) => void;
}>()(
  persist(
    (set) => ({
      profiles: [],
      save: (p) =>
        set((s) => ({
          profiles: s.profiles.some((x) => x.id === p.id)
            ? s.profiles.map((x) => (x.id === p.id ? p : x))
            : [...s.profiles, p],
        })),
      remove: (id) => set((s) => ({ profiles: s.profiles.filter((x) => x.id !== id) })),
    }),
    { name: 'qserial_ftp_profiles' }
  )
);
