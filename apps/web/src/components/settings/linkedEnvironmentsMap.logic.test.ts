import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetGraph,
  FLEET_CLIENT_NODE_ID,
  fleetEnvironmentNodeId,
  fleetNeighborhood,
  fleetShapeKey,
  layoutFleetGraph,
  nextFleetNode,
  type FleetEnvironmentInput,
  type FleetLayout,
} from "./linkedEnvironmentsMap.logic";

const now = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");
const id = (value: string) => EnvironmentId.make(value);
const node = (value: string) => fleetEnvironmentNodeId(id(value));

const link = (target: string, overrides: Partial<PeerLinkSummary> = {}): PeerLinkSummary => ({
  environmentId: id(target),
  label: target,
  urls: [`https://${target}.example.ts.net`],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
  ...overrides,
});

const environment = (
  name: string,
  links: ReadonlyArray<PeerLinkSummary> | FleetEnvironmentInput["outgoing"]["state"] = [],
  phase: FleetEnvironmentInput["phase"] = "connected",
): FleetEnvironmentInput => ({
  environmentId: id(name),
  label: name,
  machine: "server",
  phase,
  outgoing:
    typeof links !== "string"
      ? { state: "loaded", links }
      : links === "error"
        ? { state: "error", message: "boom" }
        : links === "loaded"
          ? { state: "loaded", links: [] }
          : { state: links },
});

const build = (environments: ReadonlyArray<FleetEnvironmentInput>) =>
  buildFleetGraph({ clientLabel: "This browser", environments, now });

const vms = (count: number, prefix = "vm") =>
  Array.from({ length: count }, (_, index) => link(`${prefix}-${index + 1}`));

/** The user's fleet: three own machines, forty VMs under one, a few under another. */
const fleet = (vmCount: number) =>
  build([
    environment("nucbox", [...vms(vmCount), link("cups")]),
    environment("cups", [link("nucbox"), ...vms(6, "lab"), link("vm-1")]),
    environment("mbp", "unknown", "offline"),
  ]);

function overlaps(layout: FleetLayout): ReadonlyArray<string> {
  const rects = [...layout.nodes.entries()];
  return rects.flatMap(([leftId, left], index) =>
    rects
      .slice(index + 1)
      .filter(
        ([, right]) =>
          left.x < right.x + right.width &&
          right.x < left.x + left.width &&
          left.y < right.y + right.height &&
          right.y < left.y + left.height,
      )
      .map(([rightId]) => `${leftId} x ${rightId}`),
  );
}

describe("buildFleetGraph", () => {
  it("draws the client, each environment once, and link-only targets apart from both", () => {
    const graph = build([
      environment("nucbox", [link("cups"), link("vm-1"), link("vm-1", { access: "full-access" })]),
      environment("cups", [link("vm-1"), link("cups")]),
      environment("nucbox", [link("ghost")]),
    ]);
    expect(graph.nodes.map((entry) => [entry.kind, entry.id])).toEqual([
      ["client", FLEET_CLIENT_NODE_ID],
      ["environment", node("nucbox")],
      ["environment", node("cups")],
      ["target", node("vm-1")],
    ]);
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      `conn:${node("nucbox")}`,
      `conn:${node("cups")}`,
      // To an environment the client also knows: an edge between the two, no extra node.
      `link:${node("nucbox")}>${node("cups")}`,
      // The repeated link keeps its first entry.
      `link:${node("nucbox")}>${node("vm-1")}`,
      // A second environment reaching the same target shares its node; a self link is dropped.
      `link:${node("cups")}>${node("vm-1")}`,
    ]);
    const repeated = graph.edges.find(
      (edge) => edge.id === `link:${node("nucbox")}>${node("vm-1")}`,
    );
    expect(repeated?.kind === "link" && repeated.link.access).toBe("approval-required");
  });

  it("keeps what is not known about an environment's links apart from having none", () => {
    const graph = build([
      environment("loaded"),
      environment("offline", "unknown", "offline"),
      environment("off", "off"),
      environment("failed", "error"),
    ]);
    expect(
      graph.nodes.flatMap((entry) =>
        entry.kind === "environment" ? [[entry.label, entry.outgoing, entry.outgoingError]] : [],
      ),
    ).toEqual([
      ["loaded", "loaded", null],
      ["offline", "unknown", null],
      ["off", "off", null],
      ["failed", "error", "boom"],
    ]);
    expect(graph.edges.map((edge) => edge.kind === "connection" && edge.connected)).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it("reads each link's health at the given time", () => {
    const graph = build([
      environment("host", [
        link("soon", { expiresAt: DateTime.makeUnsafe("2026-11-21T12:00:00.000Z") }),
        link("gone", { expiresAt: DateTime.makeUnsafe("2026-11-18T12:00:00.000Z") }),
        link("down", { status: "unreachable", lastError: "timed out" }),
      ]),
    ]);
    expect(graph.edges.flatMap((edge) => (edge.kind === "link" ? [edge.health] : []))).toEqual([
      { kind: "reachable", expiresInDays: 2 },
      { kind: "expired" },
      { kind: "unreachable", detail: "timed out" },
    ]);
  });
});

describe("fleetNeighborhood", () => {
  // mbp -> nucbox -> vm: mbp's agents get nothing on vm, so the highlight must stop at nucbox.
  const graph = build([environment("mbp", [link("nucbox")]), environment("nucbox", [link("vm")])]);

  it.each([
    {
      label: "a node lights what it links to and what links to it, one hop only",
      focus: { kind: "node", id: node("nucbox") } as const,
      nodes: [FLEET_CLIENT_NODE_ID, node("mbp"), node("nucbox"), node("vm")],
      edges: [
        `conn:${node("nucbox")}`,
        `link:${node("mbp")}>${node("nucbox")}`,
        `link:${node("nucbox")}>${node("vm")}`,
      ],
    },
    {
      label: "a link is not followed through the machine it reaches",
      focus: { kind: "node", id: node("mbp") } as const,
      nodes: [FLEET_CLIENT_NODE_ID, node("mbp"), node("nucbox")],
      edges: [`conn:${node("mbp")}`, `link:${node("mbp")}>${node("nucbox")}`],
    },
    {
      label: "an edge lights itself and its two ends",
      focus: { kind: "edge", id: `link:${node("nucbox")}>${node("vm")}` } as const,
      nodes: [node("nucbox"), node("vm")],
      edges: [`link:${node("nucbox")}>${node("vm")}`],
    },
    {
      label: "a node that left the graph lights nothing",
      focus: { kind: "node", id: node("gone") } as const,
      nodes: [],
      edges: [],
    },
  ])("$label", ({ focus, nodes, edges }) => {
    const neighborhood = fleetNeighborhood(graph, focus);
    expect([...neighborhood.nodes].toSorted()).toEqual(nodes.toSorted());
    expect([...neighborhood.edges].toSorted()).toEqual(edges.toSorted());
  });
});

describe("layoutFleetGraph", () => {
  it.each([
    { count: 3, graph: build([environment("cups", [link("nucbox")]), environment("nucbox")]) },
    { count: 50, graph: fleet(40) },
  ])("places every node and edge without overlap at $count nodes", ({ count, graph }) => {
    const layout = layoutFleetGraph(graph);
    expect(graph.nodes).toHaveLength(count);
    expect([...layout.nodes.keys()].toSorted()).toEqual(
      graph.nodes.map((entry) => entry.id).toSorted(),
    );
    expect([...layout.edges.keys()].toSorted()).toEqual(
      graph.edges.map((edge) => edge.id).toSorted(),
    );
    expect(overlaps(layout)).toEqual([]);
    for (const rect of layout.nodes.values()) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
    }
    for (const geometry of layout.edges.values()) expect(geometry.d).not.toMatch(/NaN|undefined/);
    for (const harness of layout.harnesses) expect(harness.d).not.toMatch(/NaN|undefined/);
  });

  it("draws the same fleet the same way whatever order its links arrive in", () => {
    const forward = build([environment("nucbox", vms(40)), environment("cups", [link("nucbox")])]);
    const reversed = build([
      environment("nucbox", vms(40).toReversed()),
      environment("cups", [link("nucbox")]),
    ]);
    const layout = layoutFleetGraph(forward);
    expect(layoutFleetGraph(forward)).toEqual(layout);
    expect(layoutFleetGraph(reversed).nodes).toEqual(layout.nodes);
  });

  it("moves nothing when only a link's health changes, and re-lays out when the shape does", () => {
    const before = build([environment("host", [link("vm")])]);
    const unhealthy = build([environment("host", [link("vm", { status: "unreachable" })])]);
    const grown = build([environment("host", [link("vm"), link("vm-2")])]);
    expect(fleetShapeKey(unhealthy)).toBe(fleetShapeKey(before));
    expect(fleetShapeKey(grown)).not.toBe(fleetShapeKey(before));
  });

  it("routes a machine's own bay through one harness and other links on their own", () => {
    const graph = fleet(40);
    const layout = layoutFleetGraph(graph);
    expect(layout.harnesses.map((harness) => [harness.parentId, harness.memberIds.length])).toEqual(
      [
        [node("nucbox"), 40],
        [node("cups"), 6],
      ],
    );
    // Links between known environments and into another machine's bay carry their own badge.
    expect(
      [...layout.edges.entries()]
        .flatMap(([edgeId, geometry]) => (geometry.badge === null ? [] : [edgeId]))
        .toSorted(),
    ).toEqual([
      `link:${node("cups")}>${node("nucbox")}`,
      `link:${node("cups")}>${node("vm-1")}`,
      `link:${node("nucbox")}>${node("cups")}`,
    ]);
  });
});

describe("nextFleetNode", () => {
  it("steps between the columns and along a bay", () => {
    const layout = layoutFleetGraph(build([environment("host", vms(2))]));
    expect(nextFleetNode(layout, FLEET_CLIENT_NODE_ID, "right")).toBe(node("host"));
    expect(nextFleetNode(layout, node("host"), "left")).toBe(FLEET_CLIENT_NODE_ID);
    expect(nextFleetNode(layout, node("vm-1"), "down")).toBe(node("vm-2"));
    expect(nextFleetNode(layout, node("vm-2"), "down")).toBeNull();
  });
});
