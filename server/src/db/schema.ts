import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["owner", "admin", "developer", "viewer"]);
export const serviceTypeEnum = pgEnum("service_type", ["dockerfile", "compose"]);
export const serviceStatusEnum = pgEnum("service_status", ["stopped", "running", "deploying", "failed"]);
export const deployStatusEnum = pgEnum("deploy_status", ["queued", "building", "success", "failed"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull().default("developer"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const services = pgTable("services", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: serviceTypeEnum("type").notNull().default("dockerfile"),
  gitUrl: text("git_url"),
  gitBranch: text("git_branch").default("main"),
  dockerfilePath: text("dockerfile_path").default("Dockerfile"),
  composePath: text("compose_path").default("docker-compose.yml"),
  composeContent: text("compose_content"),
  dockerfileContent: text("dockerfile_content"),
  domain: text("domain"),
  internalPort: integer("internal_port").default(80),
  status: serviceStatusEnum("status").notNull().default("stopped"),
  currentContainerId: text("current_container_id"),
  webhookSecret: text("webhook_secret"),
  webhookEnabled: boolean("webhook_enabled").notNull().default(true),
  sshPublicKey: text("ssh_public_key"),
  sshPrivateKey: text("ssh_private_key"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const envVars = pgTable("env_vars", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }).notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  isSecret: boolean("is_secret").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const deployments = pgTable("deployments", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }).notNull(),
  commitHash: text("commit_hash"),
  commitMessage: text("commit_message"),
  triggeredBy: text("triggered_by").notNull().default("manual"),
  status: deployStatusEnum("status").notNull().default("queued"),
  logs: text("logs").default(""),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  details: text("details"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
