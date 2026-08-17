import { redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { LoginForm } from "./login-form";

export default async function Home() {
  const token = await getSessionToken();
  if (token) redirect("/dashboard");

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 className="display">Atelier</h1>
        <p className="subtitle">Manager Console — sign in with a bearer token.</p>
        <LoginForm />
        <p className="hint">
          Don't have a token? Run{" "}
          <span className="mono">pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts</span>{" "}
          in the platform directory to mint one.
        </p>
      </div>
    </div>
  );
}
