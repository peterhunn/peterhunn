"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HouseholdId } from "@atelier/domain";
import {
  runVendorScheduleIntent,
  runVendorPurchaseIntent,
  runCalendarCreateIntent,
  runCalendarRescheduleIntent,
  runResearchIntent,
  planAndRun,
} from "./actions";

type Mode =
  | "plan"
  | "schedule"
  | "purchase"
  | "calendar_create"
  | "calendar_reschedule"
  | "research";

export function RunIntentForm({ householdId }: { householdId: HouseholdId }) {
  const [mode, setMode] = useState<Mode>("plan");
  const [prompt, setPrompt] = useState(
    "Please schedule quarterly HVAC service at the primary residence.",
  );
  const [serviceType, setServiceType] = useState("HVAC");
  const [propertyNodeId, setPropertyNodeId] = useState("nod_home");
  const [itemDescription, setItemDescription] = useState("Ergonomic desk chair");
  const [amount, setAmount] = useState("750");
  const [question, setQuestion] = useState(
    "Compare three ergonomic office chairs under $800.",
  );
  const [title, setTitle] = useState("Board meeting");
  const [startAt, setStartAt] = useState("2026-09-01T15:00");
  const [endAt, setEndAt] = useState("2026-09-01T16:00");
  const [appointmentNodeId, setAppointmentNodeId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const toIso = (v: string) => (v ? new Date(v).toISOString() : "");

  return (
    <form
      className="run-intent"
      action={() => {
        setMessage(null);
        startTransition(async () => {
          let res;
          switch (mode) {
            case "plan":
              res = await planAndRun(householdId, prompt);
              break;
            case "schedule":
              res = await runVendorScheduleIntent(householdId, {
                serviceType,
                propertyNodeId,
              });
              break;
            case "purchase":
              res = await runVendorPurchaseIntent(householdId, {
                serviceType,
                itemDescription,
                amountUsd: Number(amount),
              });
              break;
            case "calendar_create":
              res = await runCalendarCreateIntent(householdId, {
                title,
                startAt: toIso(startAt),
                endAt: toIso(endAt),
              });
              break;
            case "calendar_reschedule":
              res = await runCalendarRescheduleIntent(householdId, {
                appointmentNodeId,
                toStartAt: toIso(startAt),
                toEndAt: toIso(endAt),
              });
              break;
            case "research":
              res = await runResearchIntent(householdId, { question });
              break;
          }
          setMessage(res.message);
          router.refresh();
        });
      }}
    >
      <div className="form-field inline">
        <label htmlFor="mode">Intent</label>
        <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="plan">natural language → plan &amp; run</option>
          <option value="schedule">vendor.schedule</option>
          <option value="purchase">vendor.purchase</option>
          <option value="calendar_create">calendar.appointment.create</option>
          <option value="calendar_reschedule">calendar.appointment.reschedule</option>
          <option value="research">research.query</option>
        </select>
      </div>

      {mode === "research" ? (
        <div className="form-field inline" style={{ flex: "1 1 100%", minWidth: 300 }}>
          <label htmlFor="question">Question</label>
          <input
            id="question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            style={{ minWidth: 320 }}
          />
        </div>
      ) : null}

      {mode === "plan" ? (
        <div className="form-field inline" style={{ flex: "1 1 100%", minWidth: 300 }}>
          <label htmlFor="prompt">Say it in plain English</label>
          <input
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ minWidth: 320 }}
          />
        </div>
      ) : null}

      {mode === "schedule" || mode === "purchase" ? (
        <div className="form-field inline">
          <label htmlFor="serviceType">Service / category</label>
          <input
            id="serviceType"
            value={serviceType}
            onChange={(e) => setServiceType(e.target.value)}
          />
        </div>
      ) : null}

      {mode === "schedule" ? (
        <div className="form-field inline">
          <label htmlFor="propertyNodeId">Property node id</label>
          <input
            id="propertyNodeId"
            value={propertyNodeId}
            onChange={(e) => setPropertyNodeId(e.target.value)}
          />
        </div>
      ) : null}

      {mode === "purchase" ? (
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
      ) : null}

      {mode === "calendar_create" ? (
        <div className="form-field inline">
          <label htmlFor="title">Title</label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      ) : null}

      {mode === "calendar_reschedule" ? (
        <div className="form-field inline">
          <label htmlFor="appointmentNodeId">Appointment node id</label>
          <input
            id="appointmentNodeId"
            value={appointmentNodeId}
            onChange={(e) => setAppointmentNodeId(e.target.value)}
          />
        </div>
      ) : null}

      {mode === "calendar_create" || mode === "calendar_reschedule" ? (
        <>
          <div className="form-field inline">
            <label htmlFor="startAt">Start (local)</label>
            <input
              id="startAt"
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          </div>
          <div className="form-field inline">
            <label htmlFor="endAt">End (local)</label>
            <input
              id="endAt"
              type="datetime-local"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
            />
          </div>
        </>
      ) : null}

      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Running..." : "Run intent"}
      </button>
      {message ? <p className="hint">{message}</p> : null}
    </form>
  );
}
