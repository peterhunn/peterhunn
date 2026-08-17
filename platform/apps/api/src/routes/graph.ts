import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { graphRepo, householdRepo, type Db } from "@atelier/db";
import {
  NodeCandidate,
  EdgeCandidate,
  type HouseholdId,
  type NodeType,
  type EdgeType,
} from "@atelier/domain";

const ListNodesQuery = z.object({
  type: z.string().optional(),
});

const ListEdgesQuery = z.object({
  type: z.string().optional(),
  fromNodeId: z.string().optional(),
  toNodeId: z.string().optional(),
});

export const graphRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const households = householdRepo(db);
  const graph = graphRepo(db);

  const requireHousehold = (id: string) => {
    const hh = households.get(id as HouseholdId);
    if (!hh) return null;
    return hh;
  };

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/nodes",
    async (req, reply) => {
      const hh = requireHousehold(req.params.householdId);
      if (!hh) return reply.code(404).send({ error: "household_not_found" });
      const q = ListNodesQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      const opts = q.data.type ? { type: q.data.type as NodeType } : {};
      return { nodes: graph.listNodes(hh.id, opts) };
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/nodes",
    async (req, reply) => {
      const hh = requireHousehold(req.params.householdId);
      if (!hh) return reply.code(404).send({ error: "household_not_found" });
      const parsed = NodeCandidate.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }
      try {
        const node = graph.createNode(hh.id, parsed.data);
        return reply.code(201).send({ node });
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "ontology_error", message: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/edges",
    async (req, reply) => {
      const hh = requireHousehold(req.params.householdId);
      if (!hh) return reply.code(404).send({ error: "household_not_found" });
      const q = ListEdgesQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      const opts: Parameters<typeof graph.listEdges>[1] = {};
      if (q.data.type) opts.type = q.data.type as EdgeType;
      if (q.data.fromNodeId) opts.fromNodeId = q.data.fromNodeId as never;
      if (q.data.toNodeId) opts.toNodeId = q.data.toNodeId as never;
      return { edges: graph.listEdges(hh.id, opts) };
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/edges",
    async (req, reply) => {
      const hh = requireHousehold(req.params.householdId);
      if (!hh) return reply.code(404).send({ error: "household_not_found" });
      const parsed = EdgeCandidate.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const edge = graph.createEdge(hh.id, parsed.data);
      return reply.code(201).send({ edge });
    },
  );
};
