import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/dilly",
  jwtSecret: process.env.JWT_SECRET || "dilly-super-secret-jwt-key-replace-in-production",
  dockerHost: process.env.DOCKER_HOST, // undefined defaults to default socket / named pipe
  caddyApiUrl: process.env.CADDY_API_URL || "http://localhost:2019",
  dataDir: process.env.DATA_DIR || "./.dilly_data",
  isDev: process.env.NODE_ENV !== "production",
};
