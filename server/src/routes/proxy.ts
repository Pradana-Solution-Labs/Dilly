import { Elysia } from "elysia";
import { authMiddleware } from "../middlewares/auth.js";
import { caddyService } from "../services/caddy.js";
import { db, schema } from "../db/index.js";
import { isNotNull } from "drizzle-orm";

export const proxyRoutes = new Elysia({ prefix: "/api/proxy" })
  .use(authMiddleware)
  .get(
    "/status",
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const isLive = await caddyService.ping();
      return {
        caddyAvailable: isLive,
      };
    },
    {
      requireRole: "admin",
    }
  )
  .post(
    "/sync",
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      await caddyService.initializeServer();

      // Find all services with domain set and running status
      const activeServices = await db.select().from(schema.services).where(isNotNull(schema.services.domain));
      let syncedCount = 0;

      for (const service of activeServices) {
        if (service.domain && service.status === "running") {
          const upstreamHost = service.name;
          const ok = await caddyService.setRoute(service.domain, upstreamHost, service.internalPort || 80);
          if (ok) syncedCount++;
        }
      }

      return {
        success: true,
        totalConfigured: activeServices.length,
        syncedCount,
      };
    },
    {
      requireRole: "owner",
    }
  );
