// Compact 30-day cost dashboard rendered from
// GET /households/:id/model-calls/daily. Pure SVG so no
// charting deps; each day is a stacked column tier-by-tier.
// Doubles as a first check for "which tier is our spend
// coming from?" without leaving the household page.

interface DailyRow {
  day: string;
  totalUsd: number;
  totalCalls: number;
  byTier: Record<string, { usd: number; calls: number }>;
}

const TIER_ORDER = ["t0", "t1", "t2", "t3"] as const;
const TIER_COLOR: Record<string, string> = {
  t0: "#94a3b8",
  t1: "#60a5fa",
  t2: "#f59e0b",
  t3: "#ef4444",
};

const fillDayRange = (windowDays: number, days: DailyRow[]): DailyRow[] => {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const now = new Date();
  const filled: DailyRow[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    const key = d.toISOString().slice(0, 10);
    filled.push(
      byDay.get(key) ?? {
        day: key,
        totalUsd: 0,
        totalCalls: 0,
        byTier: {},
      },
    );
  }
  return filled;
};

export function CostDashboard({
  windowDays,
  days,
}: {
  windowDays: number;
  days: DailyRow[];
}) {
  const filled = fillDayRange(windowDays, days);
  const totalUsd = filled.reduce((s, d) => s + d.totalUsd, 0);
  const totalCalls = filled.reduce((s, d) => s + d.totalCalls, 0);
  const peakUsd = Math.max(0.0001, ...filled.map((d) => d.totalUsd));

  const width = Math.max(320, filled.length * 12);
  const height = 100;
  const barW = width / filled.length;

  const perTierUsd: Record<string, number> = {};
  for (const d of filled) {
    for (const [tier, v] of Object.entries(d.byTier)) {
      perTierUsd[tier] = (perTierUsd[tier] ?? 0) + v.usd;
    }
  }

  return (
    <div>
      <div className="section-head">
        <h2>Model spend (30d)</h2>
        <span className="mono">
          ${totalUsd.toFixed(4)} · {totalCalls} calls
        </span>
      </div>
      <div className="cost-chart-wrap">
        <svg
          viewBox={`0 0 ${width} ${height + 24}`}
          className="cost-chart"
          preserveAspectRatio="none"
        >
          {filled.map((d, i) => {
            let y = height;
            return (
              <g key={d.day}>
                {TIER_ORDER.map((tier) => {
                  const usd = d.byTier[tier]?.usd ?? 0;
                  if (usd <= 0) return null;
                  const h = (usd / peakUsd) * (height - 4);
                  y -= h;
                  return (
                    <rect
                      key={tier}
                      x={i * barW + 1}
                      y={y}
                      width={barW - 2}
                      height={h}
                      fill={TIER_COLOR[tier] ?? "#999"}
                    >
                      <title>
                        {d.day} · {tier} · ${usd.toFixed(4)} ·{" "}
                        {d.byTier[tier]?.calls ?? 0} calls
                      </title>
                    </rect>
                  );
                })}
                {i === filled.length - 1 || i === 0 ? (
                  <text
                    x={i * barW + barW / 2}
                    y={height + 14}
                    textAnchor={i === 0 ? "start" : "end"}
                    className="cost-chart-label"
                  >
                    {d.day.slice(5)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="cost-legend">
        {TIER_ORDER.filter((t) => (perTierUsd[t] ?? 0) > 0).map((tier) => (
          <span key={tier} className="cost-legend-item">
            <span
              className="cost-legend-swatch"
              style={{ background: TIER_COLOR[tier] }}
            />
            {tier.toUpperCase()} — ${(perTierUsd[tier] ?? 0).toFixed(4)}
          </span>
        ))}
      </div>
    </div>
  );
}
