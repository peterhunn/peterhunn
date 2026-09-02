import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { graphRepo, type Db } from "@atelier/db";
import {
  nowIso,
  PlacePropertyData,
  AssetVehicleData,
  AssetEquipmentData,
  AssetMembershipData,
  AssetPetData,
  type HouseholdId,
  type NodeId,
  type NodeType,
} from "@atelier/domain";

// First-class properties & assets management. Mirrors the people
// route: the household's homes, vehicles, equipment, memberships,
// and pets live in the graph as `place.property` / `asset.*`
// nodes. This surface gives managers form-shaped CRUD without
// crafting raw graph nodes, and every write goes through graphRepo
// so provenance stays canonical.
//
// Kinds:
//   property   → place.property   (homes, offices)
//   vehicle    → asset.vehicle
//   equipment  → asset.equipment  (HVAC, appliances, gear)
//   membership → asset.membership (clubs, subscriptions)
//   pet        → asset.pet
//
// Edits use supersede-and-replace so history is preserved.

type Kind = "property" | "vehicle" | "equipment" | "membership" | "pet";

const KIND_TO_TYPE: Record<Kind, NodeType> = {
  property: "place.property",
  vehicle: "asset.vehicle",
  equipment: "asset.equipment",
  membership: "asset.membership",
  pet: "asset.pet",
};

const KIND_SCHEMAS = {
  property: PlacePropertyData,
  vehicle: AssetVehicleData,
  equipment: AssetEquipmentData,
  membership: AssetMembershipData,
  pet: AssetPetData,
} as const;

const KIND_ENUM = z.enum(["property", "vehicle", "equipment", "membership", "pet"]);

const CreateAssetBody = z.object({
  kind: KIND_ENUM,
  data: z.unknown(),
});

const PatchAssetBody = z.object({
  data: z.unknown(),
});

const kindFromType = (type: string): Kind | null => {
  const entry = (Object.entries(KIND_TO_TYPE) as Array<[Kind, NodeType]>).find(
    ([, t]) => t === type,
  );
  return entry?.[0] ?? null;
};

export const assetRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const graph = graphRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/assets",
    { config: { audit: { action: "assets.list", resourceType: "asset" } } },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const buckets: Record<Kind, Array<{ id: string; data: unknown }>> = {
        property: [],
        vehicle: [],
        equipment: [],
        membership: [],
        pet: [],
      };
      for (const [kind, type] of Object.entries(KIND_TO_TYPE) as Array<[Kind, NodeType]>) {
        for (const n of graph.listNodes(householdId, { type })) {
          buckets[kind].push({ id: n.id, data: n.data });
        }
      }
      return { assets: buckets };
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/assets",
    { config: { audit: { action: "assets.create", resourceType: "asset" } } },
    async (req, reply) => {
      const parsed = CreateAssetBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const kind = parsed.data.kind;
      const dataParsed = KIND_SCHEMAS[kind].safeParse(parsed.data.data);
      if (!dataParsed.success) {
        return reply.code(400).send({
          error: "invalid_asset_data",
          kind,
          issues: dataParsed.error.issues,
        });
      }
      const node = graph.createNode(req.householdContext as HouseholdId, {
        type: KIND_TO_TYPE[kind],
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
        asset: { id: node.id, kind, data: node.data },
      });
    },
  );

  app.patch<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/assets/:nodeId",
    { config: { audit: { action: "assets.update", resourceType: "asset" } } },
    async (req, reply) => {
      const parsed = PatchAssetBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const householdId = req.householdContext as HouseholdId;
      const current = graph.getNode(householdId, req.params.nodeId as NodeId);
      if (!current) return reply.code(404).send({ error: "not_found" });
      const kind = kindFromType(current.type);
      if (!kind) {
        return reply.code(400).send({ error: "not_an_asset", type: current.type });
      }
      const merged = {
        ...(current.data as Record<string, unknown>),
        ...(parsed.data.data as Record<string, unknown>),
      };
      const validated = KIND_SCHEMAS[kind].safeParse(merged);
      if (!validated.success) {
        return reply.code(400).send({
          error: "invalid_asset_data",
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
      return { asset: { id: replacement.id, kind, data: replacement.data } };
    },
  );

  app.delete<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/assets/:nodeId",
    { config: { audit: { action: "assets.delete", resourceType: "asset" } } },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const current = graph.getNode(householdId, req.params.nodeId as NodeId);
      if (!current) return reply.code(404).send({ error: "not_found" });
      const kind = kindFromType(current.type);
      if (!kind) return reply.code(400).send({ error: "not_an_asset" });
      graph.supersedeNode(householdId, current.id as NodeId);
      return reply.code(204).send();
    },
  );
};
