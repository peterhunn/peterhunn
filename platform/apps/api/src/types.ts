import type { Actor, HouseholdId } from "@atelier/domain";

// Fastify module augmentation — every request carries a resolved actor
// once the auth plugin has run. Routes below the auth guard can rely on
// req.actor being present.
declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
    householdContext?: HouseholdId;
  }
}
