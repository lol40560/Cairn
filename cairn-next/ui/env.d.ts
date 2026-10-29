import type { ReleaseApi } from '../shared/release-api';
declare global {
  interface Window {
    cairn: ReleaseApi;
  }
}
export {};
