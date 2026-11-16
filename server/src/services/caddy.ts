import { config } from "../config.js";

interface RouteDefinition {
  domain: string;
  upstream: string; // e.g. "my-app:80" or "172.18.0.5:3000"
}

class CaddyManager {
  private apiUrl: string;

  constructor() {
    this.apiUrl = config.caddyApiUrl;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/config/`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Generates a Caddy JSON route block for reverse proxy
   */
  private createRouteObject(domain: string, upstream: string) {
    return {
      "@id": `route-${domain.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      match: [
        {
          host: [domain],
        },
      ],
      handle: [
        {
          handler: "subroute",
          routes: [
            {
              handle: [
                {
                  handler: "reverse_proxy",
                  upstreams: [
                    {
                      dial: upstream,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      terminal: true,
    };
  }

  /**
   * Initializes basic Caddy HTTP server structure if not present
   */
  async initializeServer(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/config/apps/http`);
      if (res.status === 404 || !res.ok) {
        // Initialize minimal server config
        await fetch(`${this.apiUrl}/config/apps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            http: {
              servers: {
                srv0: {
                  listen: [":80"],
                  routes: [],
                },
              },
            },
          }),
        });
      }
    } catch (err) {
      console.warn("Could not connect to Caddy Admin API. Ensure Caddy is running.", err);
    }
  }

  /**
   * Adds or replaces a domain route in Caddy
   */
  async setRoute(domain: string, upstreamHost: string, upstreamPort: number): Promise<boolean> {
    const upstream = `${upstreamHost}:${upstreamPort}`;
    const routeObj = this.createRouteObject(domain, upstream);
    const routeId = `route-${domain.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    try {
      // First check if route exists by id
      const checkRes = await fetch(`${this.apiUrl}/id/${routeId}`);
      if (checkRes.ok) {
        // Replace existing
        const putRes = await fetch(`${this.apiUrl}/id/${routeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(routeObj),
        });
        return putRes.ok;
      } else {
        // Append to srv0 routes
        const postRes = await fetch(`${this.apiUrl}/config/apps/http/servers/srv0/routes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(routeObj),
        });
        return postRes.ok;
      }
    } catch (err) {
      console.error(`Failed to set Caddy route for ${domain}:`, err);
      return false;
    }
  }

  /**
   * Removes route by domain
   */
  async removeRoute(domain: string): Promise<boolean> {
    const routeId = `route-${domain.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    try {
      const res = await fetch(`${this.apiUrl}/id/${routeId}`, {
        method: "DELETE",
      });
      return res.ok || res.status === 404;
    } catch (err) {
      console.error(`Failed to remove Caddy route for ${domain}:`, err);
      return false;
    }
  }
}

export const caddyService = new CaddyManager();
