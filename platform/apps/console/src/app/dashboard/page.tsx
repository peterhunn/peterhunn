import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { api } from "@/lib/api";
import { ConsoleNav } from "../console-nav";

export default async function Dashboard() {
  const token = await getSessionToken();
  if (!token) redirect("/");

  const client = api(token);
  const [{ actor }, { households }] = await Promise.all([
    client.me(),
    client.listHouseholds(),
  ]);

  return (
    <>
      <ConsoleNav managerName={actor.displayName} />
      <main className="page">
        <p className="eyebrow">Households under management</p>
        <h1 className="display">Good morning, {actor.displayName.split(" ")[0]}.</h1>
        <p className="subtitle">
          {households.length === 0
            ? "No households granted to this manager yet."
            : `${households.length} household${households.length === 1 ? "" : "s"} in your care.`}
        </p>

        {households.length === 0 ? (
          <div className="empty">
            Run the seed script or grant this manager to a household from the API.
          </div>
        ) : (
          <div className="grid-cards">
            {households.map((h) => (
              <Link
                key={h.id}
                href={`/households/${h.id}`}
                className="card household-card"
              >
                <p className="name">{h.name}</p>
                <div className="meta">
                  <span className={`tag tier-${h.tier}`}>{h.tier}</span>
                  <span>Since {new Date(h.createdAt).toLocaleDateString()}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
