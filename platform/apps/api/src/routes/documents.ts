import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { graphRepo, type Db } from "@atelier/db";
import {
  DocumentData,
  nowIso,
  type HouseholdId,
  type NodeId,
  type NodeType,
} from "@atelier/domain";

// First-class documents CRUD. Documents live in the graph as
// document.<subcategory> nodes; this route is the form-shaped
// manager surface over that ontology, mirroring people/assets.
//
// The `subcategory` in the API maps to the last segment of the node
// type — identity, legal, policy, record, receipt. All five share
// the same DocumentData shape (title, category, storedAt?,
// expiresAt?, notes?); the sub-category is what the graph type name
// carries so downstream (playbooks, renewal scans, travel agent's
// identity-doc check) can filter by kind without inspecting fields.
//
// The `storedAt` field is a URI pointer to the file. Today it's a
// free string the manager fills in ("./passport.pdf",
// "https://vault.example/…"). A follow-up commit adds real blob
// storage backed by the API — at that point the platform stamps
// atelier://blob/<sha256> here on upload.

const SUBCATEGORIES = ["identity", "legal", "policy", "record", "receipt"] as const;
type Subcategory = (typeof SUBCATEGORIES)[number];

const typeFor = (sub: Subcategory): NodeType =>
  `document.${sub}` as NodeType;

const subcategoryFromType = (type: string): Subcategory | null => {
  if (!type.startsWith("document.")) return null;
  const suffix = type.slice("document.".length) as Subcategory;
  return (SUBCATEGORIES as readonly string[]).includes(suffix) ? suffix : null;
};

const CreateDocumentBody = z.object({
  subcategory: z.enum(SUBCATEGORIES),
  data: z.unknown(),
});

const PatchDocumentBody = z.object({
  data: z.unknown(),
});

export const documentRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const graph = graphRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/documents",
    { config: { audit: { action: "documents.list", resourceType: "document" } } },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const buckets: Record<Subcategory, Array<{ id: string; data: unknown }>> = {
        identity: [],
        legal: [],
        policy: [],
        record: [],
        receipt: [],
      };
      for (const sub of SUBCATEGORIES) {
        for (const n of graph.listNodes(householdId, { type: typeFor(sub) })) {
          buckets[sub].push({ id: n.id, data: n.data });
        }
      }
      return { documents: buckets };
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/documents",
    { config: { audit: { action: "documents.create", resourceType: "document" } } },
    async (req, reply) => {
      const parsed = CreateDocumentBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const dataParsed = DocumentData.safeParse(parsed.data.data);
      if (!dataParsed.success) {
        return reply.code(400).send({
          error: "invalid_document_data",
          issues: dataParsed.error.issues,
        });
      }
      const node = graph.createNode(req.householdContext as HouseholdId, {
        type: typeFor(parsed.data.subcategory),
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
        document: {
          id: node.id,
          subcategory: parsed.data.subcategory,
          data: node.data,
        },
      });
    },
  );

  app.patch<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/documents/:nodeId",
    { config: { audit: { action: "documents.update", resourceType: "document" } } },
    async (req, reply) => {
      const parsed = PatchDocumentBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const householdId = req.householdContext as HouseholdId;
      const current = graph.getNode(householdId, req.params.nodeId as NodeId);
      if (!current) return reply.code(404).send({ error: "not_found" });
      const sub = subcategoryFromType(current.type);
      if (!sub) {
        return reply.code(400).send({ error: "not_a_document", type: current.type });
      }
      const merged = {
        ...(current.data as Record<string, unknown>),
        ...(parsed.data.data as Record<string, unknown>),
      };
      const validated = DocumentData.safeParse(merged);
      if (!validated.success) {
        return reply.code(400).send({
          error: "invalid_document_data",
          issues: validated.error.issues,
        });
      }
      const replacement = graph.createNode(householdId, {
        type: typeFor(sub),
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
      return {
        document: {
          id: replacement.id,
          subcategory: sub,
          data: replacement.data,
        },
      };
    },
  );

  app.delete<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/documents/:nodeId",
    { config: { audit: { action: "documents.delete", resourceType: "document" } } },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const current = graph.getNode(householdId, req.params.nodeId as NodeId);
      if (!current) return reply.code(404).send({ error: "not_found" });
      const sub = subcategoryFromType(current.type);
      if (!sub) return reply.code(400).send({ error: "not_a_document" });
      graph.supersedeNode(householdId, current.id as NodeId);
      return reply.code(204).send();
    },
  );
};
