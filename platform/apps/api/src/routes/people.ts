import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { graphRepo, type Db } from "@atelier/db";
import {
  nowIso,
  PersonPrincipalData,
  PersonMemberData,
  PersonStaffData,
  PersonContactData,
  type HouseholdId,
  type NodeId,
  type NodeType,
} from "@atelier/domain";

// First-class people management. Principals, members, staff, and
// contacts live in the graph as `person.*` nodes today. This route
// gives a manager a form-shaped surface over that instead of raw
// graph-node CRUD — each kind gets validated with the same Zod
// schemas the ontology uses, so the graph stays canonical and
// nothing bypasses provenance.
//
// Edits use supersede-and-replace: creating a new node preserves
// the history rather than overwriting it in place.

const KIND_TO_TYPE: Record<
  "principal" | "member" | "staff" | "contact",
  NodeType
> = {
  principal: "person.principal",
  member: "person.member",
  staff: "person.staff",
  contact: "person.contact",
};

const KIND_SCHEMAS = {
  principal: PersonPrincipalData,
  member: PersonMemberData,
  staff: PersonStaffData,
  contact: PersonContactData,
} as const;

const CreatePersonBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("principal"), data: z.unknown() }),
  z.object({ kind: z.literal("member"), data: z.unknown() }),
  z.object({ kind: z.literal("staff"), data: z.unknown() }),
  z.object({ kind: z.literal("contact"), data: z.unknown() }),
]);

const PatchPersonBody = z.object({
  data: z.unknown(),
});

const kindFromType = (type: string): "principal" | "member" | "staff" | "contact" | null => {
  const entry = Object.entries(KIND_TO_TYPE).find(([, t]) => t === type);
  return (entry?.[0] as ReturnType<typeof kindFromType>) ?? null;
};

export const peopleRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const graph = graphRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/people",
    { config: { audit: { action: "people.list", resourceType: "person" } } },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const buckets = {
        principal: [] as Array<{ id: string; data: unknown }>,
        member: [] as Array<{ id: string; data: unknown }>,
        staff: [] as Array<{ id: string; data: unknown }>,
        contact: [] as Array<{ id: string; data: unknown }>,
      };
      for (const [kind, type] of Object.entries(KIND_TO_TYPE)) {
        const list = graph.listNodes(householdId, { type });
        for (const n of list) {
          buckets[kind as keyof typeof buckets].push({
            id: n.id,
            data: n.data,
          });
        }
      }
      return { people: buckets };
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/people",
    { config: { audit: { action: "people.create", resourceType: "person" } } },
    async (req, reply) => {
      const parsed = CreatePersonBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const schema = KIND_SCHEMAS[parsed.data.kind];
      const dataParsed = schema.safeParse(parsed.data.data);
      if (!dataParsed.success) {
        return reply.code(400).send({
          error: "invalid_person_data",
          kind: parsed.data.kind,
          issues: dataParsed.error.issues,
        });
      }
      const node = graph.createNode(req.householdContext as HouseholdId, {
        type: KIND_TO_TYPE[parsed.data.kind],
        data: dataParsed.data,
        provenance: {
          source: "manager_observed",
          assertedBy: `${req.actor.type}:${req.actor.id}`,
          assertedAt: nowIso(),
          confidence: 1,
          status: "confirmed",
        },
      });
      return reply.code(201).send({
        person: { id: node.id, kind: parsed.data.kind, data: node.data },
      });
    },
  );

  app.patch<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/people/:nodeId",
    { config: { audit: { action: "people.update", resourceType: "person" } } },
    async (req, reply) => {
      const parsed = PatchPersonBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const householdId = req.householdContext as HouseholdId;
      const current = graph.getNode(householdId, req.params.nodeId as NodeId);
      if (!current) return reply.code(404).send({ error: "not_found" });
      const kind = kindFromType(current.type);
      if (!kind) {
        return reply
          .code(400)
          .send({ error: "not_a_person", type: current.type });
      }
      // Merge patch onto current — a manager sending a partial update
      // shouldn't wipe fields they didn't touch.
      const merged = {
        ...(current.data as Record<string, unknown>),
        ...(parsed.data.data as Record<string, unknown>),
      };
      const validated = KIND_SCHEMAS[kind].safeParse(merged);
      if (!validated.success) {
        return reply.code(400).send({
          error: "invalid_person_data",
          issues: validated.error.issues,
        });
      }
      const replacement = graph.createNode(householdId, {
        type: KIND_TO_TYPE[kind],
        data: validated.data,
        provenance: {
          source: "manager_observed",
          assertedBy: `${req.actor.type}:${req.actor.id}`,
          assertedAt: nowIso(),
          confidence: 1,
          status: "confirmed",
        },
      });
      graph.supersedeNode(householdId, current.id as NodeId, replacement.id as NodeId);
      return { person: { id: replacement.id, kind, data: replacement.data } };
    },
  );

  app.delete<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/people/:nodeId",
    { config: { audit: { action: "people.delete", resourceType: "person" } } },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const current = graph.getNode(householdId, req.params.nodeId as NodeId);
      if (!current) return reply.code(404).send({ error: "not_found" });
      const kind = kindFromType(current.type);
      if (!kind) return reply.code(400).send({ error: "not_a_person" });
      graph.supersedeNode(householdId, current.id as NodeId);
      return reply.code(204).send();
    },
  );
};
