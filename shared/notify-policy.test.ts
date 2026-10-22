import { describe, expect, it } from "bun:test";
import { alertTitle } from "./notify-policy.ts";

const pane = (fields: Record<string, string | null>) => ({ pane_id: "w1:p1", ...fields });

describe("alertTitle", () => {
  it("reads as it always has without a format", () => {
    const agentPane = pane({ cwd: "/home/me/api", terminal_title: "agent - api" });
    expect(alertTitle(agentPane, "Work PC")).toBe("Work PC · agent - api");
    expect(alertTitle(agentPane)).toBe("agent - api");
    expect(alertTitle(agentPane, "Work PC", "")).toBe("Work PC · agent - api");
  });

  it("fills a format with the pane's name, its title and the PC", () => {
    const agentPane = pane({ cwd: "/home/me", foreground_cwd: "/Users/me/api/", terminal_title: "agent - api" });
    expect(alertTitle(agentPane, "Work PC", "{name} ({pc})")).toBe("api (Work PC)");
    expect(alertTitle(agentPane, "Laptop", "{pc}: {title} {unknown}")).toBe("Laptop: agent - api {unknown}");
    expect(alertTitle(pane({ cwd: "C:\\work\\api" }), "Win", "{name} ({pc})")).toBe("api (Win)");
    // a label wins over the folder; no folder falls back to the title
    expect(alertTitle(pane({ cwd: "/srv/app", label: " review " }), "Laptop", "{name}")).toBe("review");
    expect(alertTitle(pane({ terminal_title: "vim notes.md" }), "Laptop", "{name}")).toBe("vim notes.md");
    expect(alertTitle(pane({}), "Laptop", "{name}")).toBe("w1:p1");
  });
});
