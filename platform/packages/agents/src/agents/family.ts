import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Family agent — coverage of family-domain workflows. Two intents so
// far:
//
//   family.coverage.propose — given a date window during which a
//     principal is unavailable, read the graph for household members,
//     staff, and trusted contacts, then draft a coverage plan via a
//     T2 model call. Informational: no tool invocation, no policy —
//     the plan lands in task outputs for a manager to act on.
//
//   family.school.form_due — schedule a follow-up obligation for a
//     school form. Deterministic: writes an obligation.deadline
//     candidate node linked to the member.

export const CoverageProposeAttrs = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  absentPrincipalRef: z.string().optional(),
  memberRefs: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const SchoolFormAttrs = z.object({
  memberRef: z.string(),
  formTitle: z.string(),
  dueAt: z.string().datetime(),
  notes: z.string().optional(),
});

const NAME = "family";
const VERSION = "0.1.0";

const tryParseJson = <T>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

interface CoveragePerson {
  id: string;
  type: string;
  name: string;
  role?: string;
}

export const familyAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return (
      intent.kind === "family.coverage.propose" ||
      intent.kind === "family.school.form_due"
    );
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    if (intent.kind === "family.school.form_due") {
      return handleSchoolForm(intent, ctx);
    }
    if (intent.kind === "family.coverage.propose") {
      return handleCoverage(intent, ctx);
    }
    return {
      state: "failed",
      errorMessage: `Unsupported intent: ${intent.kind}`,
    };
  },
};

const handleSchoolForm = (
  intent: Intent,
  ctx: AgentContext,
): AgentTaskOutput => {
  const parsed = SchoolFormAttrs.safeParse(intent.attrs);
  if (!parsed.success) {
    return { state: "failed", errorMessage: `Invalid attrs: ${parsed.error.message}` };
  }
  const attrs = parsed.data;

  const member = ctx.graph
    .listNodes({ type: "person.member" })
    .find((n) => n.id === attrs.memberRef);
  const memberName = member ? String(member.data["fullName"] ?? member.id) : attrs.memberRef;

  const written = ctx.writer.writeNode({
    type: "obligation.deadline",
    data: {
      title: `${attrs.formTitle} — return signed (${memberName})`,
      dueAt: attrs.dueAt,
      category: "school",
      notes: attrs.notes ?? `School form for ${memberName}, due ${attrs.dueAt}.`,
    },
    status: "candidate",
    confidence: 0.9,
    sourceRef: attrs.memberRef,
  });

  return {
    state: "completed",
    decisionSummary: `Queued school-form follow-up for ${memberName}.`,
    outputs: {
      memberRef: attrs.memberRef,
      memberName,
      obligationId: written.id,
      formTitle: attrs.formTitle,
      dueAt: attrs.dueAt,
    },
  };
};

const handleCoverage = async (
  intent: Intent,
  ctx: AgentContext,
): Promise<AgentTaskOutput> => {
  const parsed = CoverageProposeAttrs.safeParse(intent.attrs);
  if (!parsed.success) {
    return { state: "failed", errorMessage: `Invalid attrs: ${parsed.error.message}` };
  }
  const attrs = parsed.data;

  const memberNodes = ctx.graph.listNodes({ type: "person.member" });
  const staffNodes = ctx.graph.listNodes({ type: "person.staff" });
  const contactNodes = ctx.graph.listNodes({ type: "person.contact" });

  const members: CoveragePerson[] = memberNodes.map((n) => ({
    id: n.id,
    type: n.type,
    name: String(n.data["fullName"] ?? n.data["preferredName"] ?? n.id),
    role: String(n.data["relationToPrincipal"] ?? "member"),
  }));
  const staff: CoveragePerson[] = staffNodes.map((n) => ({
    id: n.id,
    type: n.type,
    name: String(n.data["fullName"] ?? n.id),
    role: String(n.data["role"] ?? "staff"),
  }));
  const contacts: CoveragePerson[] = contactNodes.map((n) => ({
    id: n.id,
    type: n.type,
    name: String(n.data["fullName"] ?? n.id),
    role: String(n.data["role"] ?? n.data["affiliation"] ?? "contact"),
  }));

  const filteredMembers =
    attrs.memberRefs && attrs.memberRefs.length > 0
      ? members.filter((m) => attrs.memberRefs!.includes(m.id))
      : members;

  if (filteredMembers.length === 0) {
    return {
      state: "escalated",
      decisionSummary: "No household members found; escalating for manager to select coverage manually.",
      outputs: { window: { startAt: attrs.startAt, endAt: attrs.endAt } },
    };
  }

  const modelRes = await ctx.callModel({
    taskClass: "family.coverage_plan",
    messages: [
      {
        role: "system",
        content:
          "You are the ATELIER Family agent. Propose a coverage plan for family members during a period a principal is unavailable. Match the right person (staff, extended family, etc.) to each routine (pickup, dinner, homework, bedtime, weekend). Return JSON: { summary, assignments: [{ memberRef, personRef, personName, routine, note? }], openQuestions: [string] }.",
        cache: true,
      },
      {
        role: "user",
        content: JSON.stringify({
          window: { startAt: attrs.startAt, endAt: attrs.endAt },
          absentPrincipalRef: attrs.absentPrincipalRef,
          notes: attrs.notes,
          members: filteredMembers,
          staff,
          contacts,
        }),
      },
    ],
    maxOutputTokens: 800,
  });

  type Plan = {
    summary?: string;
    assignments?: Array<{
      memberRef?: string;
      personRef?: string;
      personName?: string;
      routine?: string;
      note?: string;
    }>;
    openQuestions?: string[];
  };
  const plan =
    tryParseJson<Plan>(modelRes.content) ?? {
      summary: modelRes.content.slice(0, 400),
      assignments: [],
      openQuestions: [],
    };

  const summary =
    plan.summary ??
    `Coverage plan drafted for ${filteredMembers.length} member${
      filteredMembers.length === 1 ? "" : "s"
    } across ${attrs.startAt} → ${attrs.endAt}.`;

  return {
    state: "completed",
    decisionSummary: summary,
    outputs: {
      window: { startAt: attrs.startAt, endAt: attrs.endAt },
      absentPrincipalRef: attrs.absentPrincipalRef,
      members: filteredMembers,
      staff,
      contacts,
      plan: {
        summary,
        assignments: plan.assignments ?? [],
        openQuestions: plan.openQuestions ?? [],
      },
    },
  };
};
