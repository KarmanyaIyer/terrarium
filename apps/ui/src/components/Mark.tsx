/** The Terrarium mark: a sealed jar with a plant growing in it. Brand, Home in the sidebar, and the Home page title. */
export function TerrariumMark({ size = 15 }: { size?: number }) {
  return (
    <svg className="mark" viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <rect x="5" y="0.8" width="6" height="1.8" rx="0.5" fill="currentColor" />
      <path d="M5.6 2.6v1.1C4 4.3 2.8 5.5 2.8 7.3v5.2c0 1.5 1 2.7 2.6 2.7h5.2c1.6 0 2.6-1.2 2.6-2.7V7.3c0-1.8-1.2-3-2.8-3.6V2.6" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M8 13.6V7.2" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
      <path d="M8 7.8C8 6.2 9 5.2 10.6 5.2c0 1.6-1 2.6-2.6 2.6ZM8 10C8 8.5 6.9 7.4 5.3 7.4c0 1.6 1.1 2.6 2.7 2.6ZM8 11.6c0-1.3.9-2.2 2.5-2.2 0 1.4-1 2.2-2.5 2.2Z" fill="currentColor" />
    </svg>
  );
}
