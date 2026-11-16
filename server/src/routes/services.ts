import { Elysia, t } from "elysia";
import { authMiddleware } from "../middlewares/auth.js";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { dockerService } from "../services/docker.js";
import { caddyService } from "../services/caddy.js";

export const serviceRoutes = new Elysia({ prefix: "/api/services" })
  .use(authMiddleware)
  .post(
    "/project/:projectId",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, params.projectId));
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const [created] = await db
        .insert(schema.services)
        .values({
          projectId: project.id,
          name: body.name,
          type: body.type,
          gitUrl: body.gitUrl,
          gitBranch: body.gitBranch || "main",
          dockerfilePath: body.dockerfilePath || "Dockerfile",
          composePath: body.composePath || "docker-compose.yml",
          domain: body.domain,
          internalPort: body.internalPort || 80,
        })
        .returning();

      return created;
    },
    {
      requireRole: "admin",
      body: t.Object({
        name: t.String({ minLength: 2, maxLength: 50 }),
        type: t.Union([t.Literal("dockerfile"), t.Literal("compose")]),
        gitUrl: t.Optional(t.String()),
        gitBranch: t.Optional(t.String()),
        dockerfilePath: t.Optional(t.String()),
        composePath: t.Optional(t.String()),
        domain: t.Optional(t.String()),
        internalPort: t.Optional(t.Number()),
      }),
    }
  )
  .get(
    "/:id",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      const envList = await db
        .select({
          id: schema.envVars.id,
          key: schema.envVars.key,
          value: schema.envVars.value,
          isSecret: schema.envVars.isSecret,
        })
        .from(schema.envVars)
        .where(eq(schema.envVars.serviceId, service.id));

      // Obfuscate secret values for viewer role
      const safeEnv = envList.map((env) => ({
        ...env,
        value: env.isSecret && user.role === "viewer" ? "••••••••" : env.value,
      }));

      return {
        ...service,
        envVars: safeEnv,
      };
    },
    {
      requireRole: "viewer",
    }
  )
  .patch(
    "/:id",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      const [updated] = await db
        .update(schema.services)
        .set({
          ...body,
          updatedAt: new Date(),
        })
        .where(eq(schema.services.id, params.id))
        .returning();

      // If domain changed, update Caddy route
      if (body.domain !== undefined && body.domain !== service.domain) {
        if (service.domain) {
          await caddyService.removeRoute(service.domain);
        }
        if (body.domain && updated.currentContainerId) {
          await caddyService.setRoute(body.domain, updated.name, updated.internalPort || 80);
        }
      }

      return updated;
    },
    {
      requireRole: "admin",
      body: t.Object({
        name: t.Optional(t.String()),
        gitUrl: t.Optional(t.String()),
        gitBranch: t.Optional(t.String()),
        dockerfilePath: t.Optional(t.String()),
        composePath: t.Optional(t.String()),
        domain: t.Optional(t.String()),
        internalPort: t.Optional(t.Number()),
      }),
    }
  )
  .delete(
    "/:id",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      // Cleanup proxy
      if (service.domain) {
        await caddyService.removeRoute(service.domain);
      }

      // Cleanup container
      if (service.currentContainerId) {
        try {
          await dockerService.stopContainer(service.currentContainerId);
          await dockerService.removeContainer(service.currentContainerId);
        } catch (e) {
          console.warn("Cleanup container failed:", e);
        }
      }

      await db.delete(schema.services).where(eq(schema.services.id, params.id));

      return { success: true };
    },
    {
      requireRole: "admin",
    }
  )
  .post(
    "/:id/env",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      // Upsert env vars: delete existing matching keys, then insert
      for (const item of body.variables) {
        await db
          .delete(schema.envVars)
          .where(and(eq(schema.envVars.serviceId, service.id), eq(schema.envVars.key, item.key)));

        await db.insert(schema.envVars).values({
          serviceId: service.id,
          key: item.key,
          value: item.value,
          isSecret: item.isSecret ?? false,
        });
      }

      return { success: true };
    },
    {
      requireRole: "developer",
      body: t.Object({
        variables: t.Array(
          t.Object({
            key: t.String(),
            value: t.String(),
            isSecret: t.Optional(t.Boolean()),
          })
        ),
      }),
    }
  )
  .get(
    "/:id/stats",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service || !service.currentContainerId) {
        return { running: false, stats: null };
      }

      try {
        const stats = await dockerService.getContainerStats(service.currentContainerId);
        // Calculate CPU & memory percentage
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
        const systemCpuDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
        const onlineCpus = stats.cpu_stats.online_cpus || 1;
        const cpuPercent = systemCpuDelta > 0 ? (cpuDelta / systemCpuDelta) * onlineCpus * 100 : 0;

        const memoryUsage = stats.memory_stats.usage || 0;
        const memoryLimit = stats.memory_stats.limit || 1;
        const memoryPercent = (memoryUsage / memoryLimit) * 100;

        return {
          running: true,
          stats: {
            cpuPercent: Math.round(cpuPercent * 100) / 100,
            memoryBytes: memoryUsage,
            memoryLimitBytes: memoryLimit,
            memoryPercent: Math.round(memoryPercent * 100) / 100,
          },
        };
      } catch (err) {
        return { running: false, error: (err as any).message };
      }
    },
    {
      requireRole: "viewer",
    }
  );
