import type { Activity } from "./types";
export default function ActivityBadge({
  activity,
  compact = false,
}: {
  activity?: Activity;
  compact?: boolean;
}) {
  if (!activity) return null;
  const label =
    activity.state === "working"
      ? "Working"
      : activity.state === "unfinished"
        ? "Unfinished"
        : activity.state === "interrupted"
          ? "Interrupted"
          : activity.state === "failed"
            ? "Failed"
            : activity.active === true
              ? "Open · idle"
              : activity.state === "idle"
                ? "Completed"
                : "Status unknown";
  return (
    <span
      className={
        "activity-badge " +
        activity.state +
        (activity.active ? " active" : "") +
        (compact ? " compact" : "")
      }
      title={activity.detail}
    >
      <span className="activity-dot" />
      {activity.snapshot ? "Snapshot · " : ""}
      {activity.active &&
      ["interrupted", "failed", "unknown"].includes(activity.state)
        ? "Open · " + label.toLowerCase()
        : label}
    </span>
  );
}
