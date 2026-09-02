import { redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { LoginForm } from "./login-form";
import { PasskeyLogin } from "./passkey-login";

export default async function Home() {
  const token = await getSessionToken();
  if (token) redirect("/dashboard");

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 className="display">Atelier</h1>
        <p className="subtitle">Manager Console — sign in.</p>
        <PasskeyLogin />
        <div className="divider">
          <span>or with a bearer token</span>
        </div>
        <LoginForm />
        <p className="hint">
          First-time setup? Sign in once with a bearer token, then register a
          passkey from{" "}
          <span className="mono">/passkeys</span>.
        </p>
      </div>
    </div>
  );
}
