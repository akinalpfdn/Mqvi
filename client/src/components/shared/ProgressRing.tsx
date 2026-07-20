/**
 * Circular progress shown over a thumbnail while its original downloads.
 *
 * No number: the ring filling IS the readout. A percentage on a 40px circle is unreadable, and the
 * question being answered is "is this moving and how far along", not "exactly how many bytes".
 */

const SIZE = 40;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type ProgressRingProps = {
  /** 0–100, or null when the total is unknown and the ring should just spin. */
  percent: number | null;
};

function ProgressRing({ percent }: ProgressRingProps) {
  const indeterminate = percent === null;
  const clamped = indeterminate ? 25 : Math.max(0, Math.min(100, percent));

  return (
    <span className="progress-ring" role="progressbar" aria-valuenow={indeterminate ? undefined : clamped}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className={indeterminate ? "spin" : undefined}>
        <circle
          className="progress-ring-track"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
        />
        <circle
          className="progress-ring-fill"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export default ProgressRing;
