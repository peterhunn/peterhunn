import { redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { api } from "@/lib/api";
import { ConsoleNav } from "../console-nav";

const TIER_LABEL: Record<string, string> = {
  T0: "Rules",
  T1: "Small",
  T2: "Mid",
  T3: "Frontier",
};

export default async function ModelsPage() {
  const token = await getSessionToken();
  if (!token) redirect("/");

  const client = api(token);
  const [{ actor }, { models }, { taskClasses }] = await Promise.all([
    client.me(),
    client.listModels().catch(() => ({ models: [] })),
    client.listTaskClasses().catch(() => ({ taskClasses: [] })),
  ]);

  const modelsByTier = new Map<string, typeof models>();
  for (const m of models) {
    const arr = modelsByTier.get(m.tier) ?? [];
    arr.push(m);
    modelsByTier.set(m.tier, arr);
  }

  return (
    <>
      <ConsoleNav managerName={actor.displayName} />
      <main className="page">
        <p className="eyebrow">Model registry</p>
        <h1 className="display">Models &amp; tiers</h1>
        <p className="subtitle">
          {models.length} model{models.length === 1 ? "" : "s"} across four tiers ·{" "}
          {taskClasses.length} task class{taskClasses.length === 1 ? "" : "es"} in the router.
        </p>

        {(["T1", "T2", "T3"] as const).map((tier) => {
          const list = modelsByTier.get(tier) ?? [];
          if (list.length === 0) return null;
          return (
            <div key={tier}>
              <div className="section-head">
                <h2>
                  {tier} — {TIER_LABEL[tier] ?? ""}
                </h2>
                <span className="mono">{list.length} available</span>
              </div>
              <table className="data">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Provider</th>
                    <th>Hosting</th>
                    <th>Context</th>
                    <th>Input $ / 1K</th>
                    <th>Output $ / 1K</th>
                    <th>Latency p50</th>
                    <th>Capabilities</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.displayName}
                        <div className="mono" style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                          {m.id}
                        </div>
                      </td>
                      <td className="mono">{m.provider}</td>
                      <td className="mono">{m.hosting}</td>
                      <td className="mono">{m.contextTokens.toLocaleString()}</td>
                      <td className="mono">${m.costPer1kInputUsd.toFixed(4)}</td>
                      <td className="mono">${m.costPer1kOutputUsd.toFixed(4)}</td>
                      <td className="mono">{m.latencyP50Ms}ms</td>
                      <td className="mono">{m.capabilities.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}

        <div className="section-head">
          <h2>Task classes</h2>
          <span className="mono">{taskClasses.length}</span>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Task class</th>
              <th>Min tier</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {taskClasses.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.id}</td>
                <td>
                  <span className="tag">{t.minTier}</span>
                </td>
                <td>{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </>
  );
}
