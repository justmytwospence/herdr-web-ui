import { describe, expect, it } from "bun:test";
import { alertTitle } from "./notify-policy.ts";

const pane = (fields: Record<string, string | null>) => ({ pane_id: "w1:p1", ...fields });

describe("alertTitle", () => {
  it("reads as it always has without a format", () => {
    const pi = pane({ cwd: "/home/me/dotfiles", terminal_title: "π - dotfiles" });
    expect(alertTitle(pi, "MacBook Pro")).toBe("MacBook Pro · π - dotfiles");
    expect(alertTitle(pi)).toBe("π - dotfiles");
    expect(alertTitle(pi, "MacBook Pro", "")).toBe("MacBook Pro · π - dotfiles");
  });

  it("fills a format with the pane's name, its title and the PC", () => {
    const pi = pane({ cwd: "/home/me", foreground_cwd: "/Users/me/dotfiles/", terminal_title: "π - dotfiles" });
    expect(alertTitle(pi, "MacBook Pro", "{name} ({pc})")).toBe("dotfiles (MacBook Pro)");
    expect(alertTitle(pi, "NUC", "{pc}: {title} {unknown}")).toBe("NUC: π - dotfiles {unknown}");
    expect(alertTitle(pane({ cwd: "C:\\work\\api" }), "Win", "{name} ({pc})")).toBe("api (Win)");
    // a label wins over the folder; no folder falls back to the title
    expect(alertTitle(pane({ cwd: "/srv/app", label: " review " }), "NUC", "{name}")).toBe("review");
    expect(alertTitle(pane({ terminal_title: "vim notes.md" }), "NUC", "{name}")).toBe("vim notes.md");
    expect(alertTitle(pane({}), "NUC", "{name}")).toBe("w1:p1");
  });
});
