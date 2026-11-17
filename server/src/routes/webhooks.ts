import { Elysia } from "elysia";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { gitService } from "../services/git.js";
import { runDeployment } from "./deploy.js";

export const webhookRoutes = new Elysia({ prefix: "/api/webhooks" })
  .post(
    "/deploy/:serviceId",
    async ({ params, request, query, set }) => {
      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.serviceId));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      if (!service.webhookEnabled) {
        set.status = 403;
        return { error: "Webhooks are disabled for this service" };
      }

      // Clone request to get raw text for HMAC verification
      const rawBody = await request.text();
      let parsedBody: any = {};
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = {};
      }

      const headers: Record<string, string | undefined> = {};
      request.headers.forEach((val, key) => {
        headers[key.toLowerCase()] = val;
      });

      // Verification logic
      if (service.webhookSecret && service.webhookSecret.trim()) {
        const ghSig = headers["x-hub-signature-256"];
        const glToken = headers["x-gitlab-token"];
        const queryToken = (query as any)?.token;
        const customHeader = headers["x-webhook-secret"];
        const authHeader = headers["authorization"];
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;

        let isVerified = false;

        // 1. GitHub HMAC Signature
        if (ghSig) {
          isVerified = gitService.verifyGitHubSignature(service.webhookSecret, ghSig, rawBody);
        }
        // 2. GitLab Secret Token
        else if (glToken) {
          isVerified = glToken === service.webhookSecret;
        }
        // 3. Query Param / Bearer / Custom Header Token
        else if (queryToken === service.webhookSecret || bearerToken === service.webhookSecret || customHeader === service.webhookSecret) {
          isVerified = true;
        }

        if (!isVerified) {
          set.status = 401;
          return { error: "Unauthorized: Invalid or missing webhook signature/token" };
        }
      }

      const eventInfo = gitService.parseWebhookPayload(headers, parsedBody);

      // Handle Ping events
      if (eventInfo.isPing) {
        return {
          status: "success",
          message: "PONG - Webhook verified successfully",
          service: service.name,
        };
      }

      // Check branch filter
      const targetBranch = service.gitBranch || "main";
      if (eventInfo.branch && eventInfo.branch !== targetBranch) {
        return {
          status: "ignored",
          message: `Push event for branch '${eventInfo.branch}' ignored (service configured for '${targetBranch}')`,
        };
      }

      // Trigger automated deployment
      try {
        const result = await runDeployment(service.id, {
          triggeredBy: "webhook",
          commitHash: eventInfo.commitHash,
          commitMessage: eventInfo.commitMessage,
          user: {
            name: eventInfo.pusher || "Git Webhook",
            role: "webhook",
          },
        });

        return {
          status: "triggered",
          message: "Deployment triggered successfully via Git webhook",
          deploymentId: result.deploymentId,
          commit: eventInfo.commitHash ? eventInfo.commitHash.substring(0, 7) : null,
        };
      } catch (err: any) {
        set.status = 500;
        return { error: `Webhook deployment failed: ${err.message}` };
      }
    }
  );
