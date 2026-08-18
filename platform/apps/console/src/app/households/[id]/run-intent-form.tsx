"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HouseholdId } from "@atelier/domain";
import { runVendorScheduleIntent } from "./actions";

export function RunIntentForm({ householdId }: { householdId: HouseholdId }) {
  const [serviceType, setServiceType] = useState("HVAC");
  const [propertyNodeId, setPropertyNodeId] = useState("nod_home");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <form
      className="run-intent"
      action={() => {
        setMessage(null);
        startTransition(async () => {
          const res = await runVendorScheduleIntent(householdId, {
            serviceType,
            propertyNodeId,
          });
          setMessage(res.message);
          router.refresh();
        });
      }}
    >
      <div className="form-field inline">
        <label htmlFor="serviceType">Service</label>
        <input
          id="serviceType"
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
        />
      </div>
      <div className="form-field inline">
        <label htmlFor="propertyNodeId">Property node id</label>
        <input
          id="propertyNodeId"
          value={propertyNodeId}
          onChange={(e) => setPropertyNodeId(e.target.value)}
        />
      </div>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Running..." : "Run intent"}
      </button>
      {message ? <p className="hint">{message}</p> : null}
    </form>
  );
}
