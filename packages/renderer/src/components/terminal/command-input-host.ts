import { createContext } from 'react';

// Shared footer below the custom buttons; each terminal retains its own input state.
export const CommandInputHostContext = createContext<HTMLDivElement | null>(null);
