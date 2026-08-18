"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HouseholdId } from "@atelier/domain";
import { runVendorScheduleIntent, runVendorPurchaseIntent } from "./actions";

type Mode = "schedule" | "purchase";

export function RunIntentForm({ householdId }: { householdId: HouseholdId }) {
  const [mode, setMode] = useState<Mode>("schedule");
  const [serviceType, setServiceType] = useState("HVAC");
  const [propertyNodeId, setPropertyNodeId] = useState("nod_home");
  const [itemDescription, setItemDescription] = useState("Ergonomic desk chair");
  const [amount, setAmount] = useState("750");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <form
      className="run-intent"
      action={() => {
        setMessage(null);
        startTransition(async () => {
          const res =
            mode === "schedule"
              ? await runVendorScheduleIntent(householdId, {
                  serviceType,
                  propertyNodeId,
                })
              : await runVendorPurchaseIntent(householdId, {
                  serviceType,
                  itemDescription,
                  amountUsd: Number(amount),
                });
          setMessage(res.message);
          router.refresh();
        });
      }}
    >
      <div className="form-field inline">
        <label htmlFor="mode">Intent</label>
        <select
          id="mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          <option value="schedule">vendor.schedule</option>
          <option value="purchase">vendor.purchase</option>
        </select>
      </div>
      <div className="form-field inline">
        <label htmlFor="serviceType">Service / category</label>
        <input
          id="serviceType"
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
        />
      </div>
      {mode === "schedule" ? (
        <div className="form-field inline">
          <label htmlFor="propertyNodeId">Property node id</label>
          <input
            id="propertyNodeId"
            value={propertyNodeId}
            onChange={(e) => setPropertyNodeId(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className="form-field inline">
            <label htmlFor="itemDescription">Item</label>
            <input
              id="itemDescription"
              value={itemDescription}
              onChange={(e) => setItemDescription(e.target.value)}
            />
          </div>
          <div className="form-field inline">
            <label htmlFor="amount">Amount USD</label>
            <input
              id="amount"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </>
      )}
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Running..." : "Run intent"}
      </button>
      {message ? <p className="hint">{message}</p> : null}
    </form>
  );
}
