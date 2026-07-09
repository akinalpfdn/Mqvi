/** Discovery badges — hand-drawn inline SVGs (no image assets). Colors come from theme tokens. */

type BadgeProps = { size?: number; title?: string };

/** Verified: a filled disc with a cut-out check. Color via CSS (.disc-badge-verified). */
export function VerifiedBadge({ size = 15, title }: BadgeProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="disc-badge-verified"
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path
        d="M8.5 12.3l2.2 2.2 4.8-5"
        fill="none"
        stroke="var(--bg-1)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
