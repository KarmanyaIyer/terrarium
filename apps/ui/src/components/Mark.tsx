/** The Terrarium mark: a lidded glass case with a sprout. Brand, Home in the sidebar, and the Home page title. */
export function TerrariumMark({ size = 15 }: { size?: number }) {
  return (
    <svg className="mark" viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <rect x="2.6" y="1.6" width="10.8" height="1.9" rx="0.7" fill="currentColor" />
      <path d="M3.4 4.6v8.1a1.6 1.6 0 0 0 1.6 1.6h6a1.6 1.6 0 0 0 1.6-1.6V4.6" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4.2 11.6h7.6" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <path
        d="M8 11.4V8.3M8 9.4c-1.5 0-2.4-.9-2.4-2.2 1.5 0 2.4.9 2.4 2.2Zm0-.7c0-1.2.8-2 2.2-2 0 1.2-.8 2-2.2 2Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
