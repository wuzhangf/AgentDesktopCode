import type { DesktopApi } from '../shared/api-types';

declare global {
  interface Window {
    codeAgentDesktop: DesktopApi;
  }
}

export type { DesktopApi as CodeAgentDesktopApi } from '../shared/api-types';
