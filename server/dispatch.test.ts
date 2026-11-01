import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";

for (const [path, status, expectedTimeouts] of [["/api/health", 200, [60]], ["/api/nope", 404, [60]]] as const) {
  it(`dispatches GET ${path} with a fake socket context`, async () => {
    // Given: isolated server services and a transport that never uses a Bun request socket.
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-"));
    const ping = spyOn(herdr, "ping").mockResolvedValue({ version: "fixture", protocol: 22, terminal_attach: false, terminal_mirror: true });
    let app: ReturnType<typeof createServer> | undefined;
    try {
      app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
      const request = new Request(`http://127.0.0.1:${app.port}${path}`, { headers: { host: `127.0.0.1:${app.port}` } });
      const timeouts: Array<{ request: Request; seconds: number }> = [];
      const ctx: ServerContext = {
        ...app.context,
        requestIP: () => ({ address: "127.0.0.1" }),
        timeout: (request, seconds) => { timeouts.push({ request, seconds }); },
        upgrade: () => { throw new Error("Unexpected WebSocket upgrade"); },
      };
      // When
      const response = await handleRequest(request, ctx);
      // Then
      expect(response?.status).toBe(status);
      expect(timeouts).toEqual(expectedTimeouts.map((seconds) => ({ request, seconds })));
      expect(response?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      app?.stop();
      ping.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

it("captures the waiting token once for each server, not for each health request", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-wait-token-"));
  const saved = process.env["OVIS_WAIT_TOKEN"];
  const ping = spyOn(herdr, "ping").mockResolvedValue({ version: "fixture", protocol: 22, terminal_attach: false, terminal_mirror: true });
  const apps: ReturnType<typeof createServer>[] = [];
  const start = (name: string) => {
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(stateDir, name), token: "", tailscaleOwner: null, machines: false, sidecar: false });
    apps.push(app);
    return app;
  };
  const read = (app: ReturnType<typeof createServer>, scope = "") => {
    const request = new Request(`http://127.0.0.1:${app.port}/api/health${scope}`);
    const ctx: ServerContext = {
      ...app.context,
      requestIP: () => ({ address: "127.0.0.1" }),
      timeout: () => {},
      upgrade: () => { throw new Error("Unexpected WebSocket upgrade"); },
    };
    return handleRequest(request, ctx);
  };
  try {
    process.env["OVIS_WAIT_TOKEN"] = " first ";
    const first = start("first");
    process.env["OVIS_WAIT_TOKEN"] = "second";
    const second = start("second");
    delete process.env["OVIS_WAIT_TOKEN"];
    for (const [app, wait_token] of [[first, "first"], [second, "second"]] as const) {
      const full = await read(app);
      expect(full?.status).toBe(200);
      expect(await full?.json()).toMatchObject({
        ok: true,
        herdr: { version: "fixture" },
        web_ui: { boot_id: app.context.services.bootId, revision: process.env["OVIS_REVISION"] ?? null, wait_token },
      });
      const bridge = await read(app, "?scope=bridge");
      expect(bridge?.status).toBe(200);
      expect(await bridge?.json()).not.toHaveProperty("web_ui");
    }
    expect(ping).toHaveBeenCalledTimes(2);
  } finally {
    for (const app of apps) app.stop();
    ping.mockRestore();
    if (saved === undefined) delete process.env["OVIS_WAIT_TOKEN"]; else process.env["OVIS_WAIT_TOKEN"] = saved;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
