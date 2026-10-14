// How a size splits by heat: safe to delete, worth a look, and the rest. In a
// list, scale draws the bar at the item's size against the largest.

export function HeatBar({
  size,
  rc,
  rv,
  className,
  scale = 1,
}: {
  size: number;
  rc: number;
  rv: number;
  className?: string;
  scale?: number;
}) {
  const a = size > 0 ? Math.min(1, rc / size) : 0;
  const b = size > 0 ? Math.min(1 - a, rv / size) : 0;
  return (
    <span
      className={className ? `heatbar ${className}` : 'heatbar'}
      style={scale < 1 ? { width: `${Math.max(1.5, scale * 100)}%` } : undefined}
      aria-hidden
    >
      <span className="heatbar-rc" style={{ width: `${a * 100}%` }} />
      <span className="heatbar-rv" style={{ width: `${b * 100}%` }} />
    </span>
  );
}
