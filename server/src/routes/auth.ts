import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { eq, count } from "drizzle-orm";
import { assertPermission, type UserRole } from "../services/rbac.js";

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
    })
  )
  .post(
    "/register",
    async ({ body, set, jwt }) => {
      const [existingUser] = await db.select().from(schema.users).where(eq(schema.users.email, body.email));
      if (existingUser) {
        set.status = 400;
        return { error: "Email already registered" };
      }

      // If this is the very first user, assign 'owner' role. Otherwise default to 'developer'
      const [userCountResult] = await db.select({ val: count() }).from(schema.users);
      const isFirstUser = (userCountResult?.val ?? 0) === 0;
      const assignedRole: UserRole = isFirstUser ? "owner" : "developer";

      const passwordHash = await Bun.password.hash(body.password);
      const [newUser] = await db
        .insert(schema.users)
        .values({
          email: body.email,
          name: body.name,
          passwordHash,
          role: assignedRole,
        })
        .returning();

      const token = await jwt.sign({
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
      });

      return {
        token,
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
        },
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 6 }),
        name: t.String({ minLength: 2 }),
      }),
    }
  )
  .post(
    "/login",
    async ({ body, set, jwt }) => {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.email));
      if (!user) {
        set.status = 401;
        return { error: "Invalid email or password" };
      }

      const isMatch = await Bun.password.verify(body.password, user.passwordHash);
      if (!isMatch) {
        set.status = 401;
        return { error: "Invalid email or password" };
      }

      const token = await jwt.sign({
        id: user.id,
        email: user.email,
        role: user.role,
      });

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    }
  )
  .get("/me", async ({ headers, jwt, set }) => {
    const authHeader = headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const token = authHeader.slice(7);
    const payload = await jwt.verify(token);
    if (!payload || typeof payload !== "object") {
      set.status = 401;
      return { error: "Invalid token" };
    }

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, (payload as any).id));
    if (!user) {
      set.status = 404;
      return { error: "User not found" };
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  })
  .get("/users", async ({ headers, jwt, set }) => {
    const authHeader = headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    const token = authHeader.slice(7);
    const payload = (await jwt.verify(token)) as any;
    if (!payload?.role) {
      set.status = 401;
      return { error: "Invalid token" };
    }

    assertPermission(payload.role, "admin");

    const userList = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users);

    return userList;
  })
  .patch(
    "/users/:id/role",
    async ({ headers, params, body, jwt, set }) => {
      const authHeader = headers["authorization"];
      if (!authHeader?.startsWith("Bearer ")) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const token = authHeader.slice(7);
      const payload = (await jwt.verify(token)) as any;
      if (!payload?.role) {
        set.status = 401;
        return { error: "Invalid token" };
      }

      // Only Owner can change roles
      assertPermission(payload.role, "owner");

      const [updated] = await db
        .update(schema.users)
        .set({ role: body.role as UserRole })
        .where(eq(schema.users.id, params.id))
        .returning({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          role: schema.users.role,
        });

      return updated;
    },
    {
      body: t.Object({
        role: t.Union([t.Literal("owner"), t.Literal("admin"), t.Literal("developer"), t.Literal("viewer")]),
      }),
    }
  );
