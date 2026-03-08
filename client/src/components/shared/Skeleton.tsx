/** Skeleton — Shimmer loading placeholders. CSS: .sk-* (globals.css) */

/** Message list skeleton */
export function MessageSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="sk-container">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-message">
          <div className="sk-avatar" />
          <div className="sk-body">
            <div className="sk-line sk-short" />
            <div className="sk-line sk-long" />
            {i % 2 === 0 && <div className="sk-line sk-medium" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Member list skeleton */
export function MemberSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="sk-container">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-member">
          <div className="sk-avatar-sm" />
          <div className="sk-line sk-name" />
        </div>
      ))}
    </div>
  );
}

/** Channel list skeleton */
export function ChannelSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-channel">
          <div className="sk-ch-icon" />
          <div className="sk-line sk-ch-name" />
        </div>
      ))}
    </>
  );
}
