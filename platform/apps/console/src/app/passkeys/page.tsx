import { redirect } from "next/navigation";
import { getSessionToken } from "@/lib/session";
import { api } from "@/lib/api";
import { ConsoleNav } from "../console-nav";
import { PasskeyList } from "./passkey-list";

export default async function PasskeysPage() {
  const token = await getSessionToken();
  if (!token) redirect("/");

  const client = api(token);
  const [{ actor }, { passkeys }] = await Promise.all([
    client.me(),
    client.listPasskeys(),
  ]);

  return (
    <>
      <ConsoleNav managerName={actor.displayName} />
      <main className="page">
        <p className="eyebrow">Security</p>
        <h1 className="display">Passkeys</h1>
        <p className="subtitle">
          Register a device once, then sign in with your fingerprint / face /
          hardware key. Bearer tokens stay available for scripting and CI.
        </p>
        <PasskeyList initialPasskeys={passkeys} />
      </main>
    </>
  );
}
