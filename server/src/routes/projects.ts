import { Elysia, t } from "elysia";
import { authMiddleware } from "../middlewares/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";

export const projectRoutes = new Elysia({ prefix: "/api/projects" })
  .use(authMiddleware)
  .get(
    "/",
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const allProjects = await db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt));
      return allProjects;
    },
    {
      requireRole: "viewer",
    }
  )
  .post(
    "/",
    async ({ body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [existing] = await db.select().from(schema.projects).where(eq(schema.projects.name, body.name));
      if (existing) {
        set.status = 400;
        return { error: "Project name already exists" };
      }

      const [created] = await db
        .insert(schema.projects)
        .values({
          name: body.name,
          description: body.description,
        })
        .returning();

      return created;
    },
    {
      requireRole: "admin",
      body: t.Object({
        name: t.String({ minLength: 2, maxLength: 50 }),
        description: t.Optional(t.String()),
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

      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, params.id));
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const projectServices = await db
        .select()
        .from(schema.services)
        .where(eq(schema.services.projectId, project.id))
        .orderBy(desc(schema.services.createdAt));

      return {
        ...project,
        services: projectServices,
      };
    },
    {
      requireRole: "viewer",
    }
  )
  .delete(
    "/:id",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [deleted] = await db
        .delete(schema.projects)
        .where(eq(schema.projects.id, params.id))
        .returning();

      if (!deleted) {
        set.status = 404;
        return { error: "Project not found" };
      }

      return { success: true, deleted };
    },
    {
      requireRole: "owner",
    }
  );
