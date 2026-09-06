import styles from "../page.module.css";
import {
  formatCost,
  formatDuration,
  type QueryStepCost,
} from "@/src/queryCost";

interface StatsBreakdownPopoverProps {
  label: string;
  breakdown: QueryStepCost[];
  metric: "duration" | "cost";
}

function formatStepValue(
  step: QueryStepCost,
  metric: "duration" | "cost",
): string {
  return metric === "duration"
    ? formatDuration(step.durationMs)
    : formatCost(step.costUsd);
}

function StatsBreakdownPopover({
  label,
  breakdown,
  metric,
}: StatsBreakdownPopoverProps) {
  return (
    <span className={styles.statsPopover} role="tooltip">
      <span className={styles.statsPopoverTitle}>{label}</span>
      <span className={styles.statsPopoverList} role="list">
        {breakdown.map((step) => (
          <span
            key={step.step}
            className={styles.statsPopoverItem}
            role="listitem"
          >
            <span className={styles.statsPopoverRow}>
              <span className={styles.statsPopoverStep}>{step.label}</span>
              <span className={styles.statsPopoverValue}>
                {formatStepValue(step, metric)}
              </span>
            </span>
            <span className={styles.statsPopoverDesc}>{step.description}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

export function StatsBreakdown({
  label,
  summary,
  metric,
  breakdown,
}: {
  label: string;
  summary: string;
  metric: "duration" | "cost";
  breakdown: QueryStepCost[];
}) {
  if (breakdown.length === 0) return <span>{summary}</span>;

  return (
    <span className={styles.statsTrigger} tabIndex={0}>
      {summary}
      <StatsBreakdownPopover
        label={label}
        breakdown={breakdown}
        metric={metric}
      />
    </span>
  );
}
