import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config.js";
import { assertPermission, type UserRole } from "../services/rbac.js";

export const authMiddleware = new Elysia({ name: "auth-plugin" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
    })
  )
  .derive({ as: "scoped" }, async ({ headers, jwt, set }) => {
    const authHeader = headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null };
    }
    const token = authHeader.slice(7);
    const payload = await jwt.verify(token);
    if (!payload || typeof payload !== "object") {
      return { user: null };
    }

    return {
      user: {
        id: (payload as any).id as string,
        email: (payload as any).email as string,
        role: (payload as any).role as UserRole,
      },
    };
  })
  .macro(({ onBeforeHandle }) => ({
    requireRole(role: UserRole) {
      onBeforeHandle(({ user, set }) => {
        if (!user) {
          set.status = 401;
          throw new Error("Unauthorized: token required");
        }
        assertPermission(user.role, role);
      });
    },
  }));
