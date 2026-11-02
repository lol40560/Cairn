import type { ReactNode } from 'react';

const shapes = {
  home: (
    <>
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
    </>
  ),
  projects: (
    <>
      <path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v2" />
      <path d="M3 9h18l-2 11H5Z" />
    </>
  ),
  files: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" />
      <path d="M14 3v5h5M9 12h6M9 16h6" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-3-5.2" />
    </>
  ),
  conflicts: (
    <>
      <path d="M10.3 4a2 2 0 0 1 3.4 0l7.1 12.2A2 2 0 0 1 19.1 19H4.9a2 2 0 0 1-1.7-2.8Z" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
  checkpoints: (
    <>
      <path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  deleted: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  folderOpen: (
    <>
      <path d="M3 8V5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v2" />
      <path d="M3 9h18l-3 11H5Z" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </>
  ),
  chevronDown: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M6 18 18 6" />
    </>
  ),
  play: (
    <>
      <path d="m9 5 10 7-10 7Z" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;

/** Decorative icons always accompany a visible or accessible text label. */
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`ui-icon ${className}`.trim()}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  );
}
