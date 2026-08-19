"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HouseholdId } from "@atelier/domain";
import { syncGmail } from "./actions";

export function SyncInboxButton({
  householdId,
  gmailConnected,
}: {
  householdId: HouseholdId;
  gmailConnected: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <span className="sync-wrap">
      <button
        className="btn secondary"
        type="button"
        disabled={pending || !gmailConnected}
        title={
          gmailConnected
            ? "Pull unread INBOX messages from Gmail"
            : "Connect Google first"
        }
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const res = await syncGmail(householdId);
            setMessage(res.message);
            router.refresh();
          });
        }}
      >
        {pending ? "Syncing..." : "Sync Gmail"}
      </button>
      {message ? <span className="sync-note mono">{message}</span> : null}
    </span>
  );
}
