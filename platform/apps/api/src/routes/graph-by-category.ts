import type { FastifyPluginAsync } from "fastify";
import { graphRepo, type Db } from "@atelier/db";
import {
  NODE_CATEGORIES,
  nodeTypesByCategory,
  type HouseholdId,
  type NodeCategory,
} from "@atelier/domain";

// Category-aware read surface. Enumerates every active node in a
// household grouped by Accord category (participant / asset /
// concept / event / transaction) or filtered to one category. New
// node types dropped into NODE_TYPE_SPECS with the right category
// show up here without any route edit — that's the whole point of
// carrying the category on the spec rather than hand-mapping in each
// route.

export const graphByCategoryRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const graph = graphRepo(db);

  app.get<{ Params: { householdId: string }; Querystring: { type?: string } }>(
    "/households/:householdId/graph/by-category",
    {
      config: { audit: { action: "graph.by_category.list", resourceType: "node" } },
    },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const buckets: Record<NodeCategory, Array<{ id: string; type: string; data: unknown }>> = {
        participant: [],
        asset: [],
        concept: [],
        event: [],
        transaction: [],
      };
      for (const cat of NODE_CATEGORIES) {
        for (const type of nodeTypesByCategory(cat)) {
          for (const n of graph.listNodes(householdId, { type })) {
            buckets[cat].push({ id: n.id, type: n.type, data: n.data });
          }
        }
      }
      return { byCategory: buckets };
    },
  );

  app.get<{ Params: { householdId: string; category: string } }>(
    "/households/:householdId/graph/by-category/:category",
    {
      config: { audit: { action: "graph.by_category.get", resourceType: "node" } },
    },
    async (req, reply) => {
      const category = req.params.category as NodeCategory;
      if (!(NODE_CATEGORIES as readonly string[]).includes(category)) {
        return reply.code(400).send({
          error: "unknown_category",
          valid: NODE_CATEGORIES,
        });
      }
      const householdId = req.householdContext as HouseholdId;
      const out: Array<{ id: string; type: string; data: unknown }> = [];
      for (const type of nodeTypesByCategory(category)) {
        for (const n of graph.listNodes(householdId, { type })) {
          out.push({ id: n.id, type: n.type, data: n.data });
        }
      }
      return { category, nodes: out };
    },
  );
};
