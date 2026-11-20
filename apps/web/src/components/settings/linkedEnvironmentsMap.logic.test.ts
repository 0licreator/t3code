import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetGraph,
  fitFleetLayout,
  fleetCanvasHeight,
  FLEET_CLIENT_NODE_ID,
  fleetEnvironmentNodeId,
  fleetNeighborhood,
  fleetShapeKey,
  layoutFleetGraph,
  nextFleetNode,
  zoomFleetView,
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

const ACCESS = [
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;

/** The reported fleet: one host, `count` machines only it reaches, at every access level. */
const oneHost = (count: number) =>
  build([
    environment(
      "host",
      Array.from({ length: count }, (_, index) =>
        link(`fs-${index + 1}`, { access: ACCESS[index % ACCESS.length]! }),
      ),
    ),
  ]);

function overlaps(layout: FleetLayout): ReadonlyArray<string> {
  const rects = [
    ...layout.nodes.entries(),
    // A lane's name sits beside its machines, inside the lane's own tray.
    ...layout.lanes.map((lane) => [`${lane.id} label`, lane.label] as const),
  ];
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
        `conn:${node("mbp")}`,
        `conn:${node("nucbox")}`,
        `link:${node("mbp")}>${node("nucbox")}`,
        `link:${node("nucbox")}>${node("vm")}`,
      ],
    },
    {
      label: "a machine known only through a link lights the way there from this client",
      focus: { kind: "node", id: node("vm") } as const,
      nodes: [FLEET_CLIENT_NODE_ID, node("nucbox"), node("vm")],
      edges: [`conn:${node("nucbox")}`, `link:${node("nucbox")}>${node("vm")}`],
    },
    {
      label: "a link is not followed through the machine it reaches",
      focus: { kind: "node", id: node("mbp") } as const,
      nodes: [FLEET_CLIENT_NODE_ID, node("mbp"), node("nucbox")],
      edges: [`conn:${node("mbp")}`, `link:${node("mbp")}>${node("nucbox")}`],
    },
    {
      label: "an edge lights itself, its two ends, and this client's way to its source",
      focus: { kind: "edge", id: `link:${node("nucbox")}>${node("vm")}` } as const,
      nodes: [FLEET_CLIENT_NODE_ID, node("nucbox"), node("vm")],
      edges: [`conn:${node("nucbox")}`, `link:${node("nucbox")}>${node("vm")}`],
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
    { count: 8, graph: oneHost(6) },
    { count: 47, graph: oneHost(45) },
    { count: 50, graph: fleet(40) },
  ])("places every node and edge without overlap at $count nodes", ({ count, graph }) => {
    const layout = layoutFleetGraph(graph);
    expect(graph.nodes).toHaveLength(count);
    expect([...layout.nodes.keys()].toSorted()).toEqual(
      graph.nodes.map((entry) => entry.id).toSorted(),
    );
    // Every edge is drawn once: on its own, or by the lane it belongs to.
    expect(
      [...layout.edges.keys(), ...layout.lanes.flatMap((lane) => lane.edgeIds)].toSorted(),
    ).toEqual(graph.edges.map((edge) => edge.id).toSorted());
    expect(overlaps(layout)).toEqual([]);
    for (const rect of [...layout.nodes.values(), ...layout.lanes.map((lane) => lane.rect)]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
    }
    for (const geometry of layout.edges.values()) expect(geometry.d).not.toMatch(/NaN|undefined/);
    for (const lane of layout.lanes) {
      expect(lane.d).not.toMatch(/NaN|undefined/);
      for (const id of lane.memberIds) {
        const rect = layout.nodes.get(id)!;
        expect(rect.x).toBeGreaterThanOrEqual(lane.label.x + lane.label.width);
        expect(rect.y).toBeGreaterThanOrEqual(lane.rect.y);
        expect(rect.y + rect.height).toBeLessThanOrEqual(lane.rect.y + lane.rect.height);
      }
    }
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
    const promoted = build([environment("host", [link("vm", { access: "full-access" })])]);
    expect(fleetShapeKey(unhealthy)).toBe(fleetShapeKey(before));
    expect(fleetShapeKey(grown)).not.toBe(fleetShapeKey(before));
    expect(fleetShapeKey(promoted)).not.toBe(fleetShapeKey(before));
  });

  it("stacks a host's machines in one lane per access level, most access on top", () => {
    const layout = layoutFleetGraph(oneHost(45));
    expect(layout.lanes.map((lane) => [lane.parentId, lane.access, lane.memberIds.length])).toEqual(
      ACCESS.toReversed().map((access) => [node("host"), access, 9]),
    );
    const tops = layout.lanes.map((lane) => lane.rect.y);
    expect(tops).toEqual(tops.toSorted((left, right) => left - right));
    // One line per lane, all leaving the host from the same point.
    expect(new Set(layout.lanes.map((lane) => lane.d.slice(0, lane.d.indexOf("C")))).size).toBe(1);
  });

  it("routes links between drawn machines on their own, with badges that do not overlap", () => {
    const graph = fleet(40);
    const layout = layoutFleetGraph(graph);
    expect(layout.lanes.map((lane) => [lane.parentId, lane.memberIds.length])).toEqual([
      [node("nucbox"), 40],
      [node("cups"), 6],
    ]);
    const badges = [...layout.edges.entries()].flatMap(([edgeId, geometry]) =>
      geometry.badge === null ? [] : [{ edgeId, ...geometry.badge }],
    );
    // Links between known environments and into another machine's bay carry their own badge.
    expect(badges.map((badge) => badge.edgeId).toSorted()).toEqual([
      `link:${node("cups")}>${node("nucbox")}`,
      `link:${node("cups")}>${node("vm-1")}`,
      `link:${node("nucbox")}>${node("cups")}`,
    ]);
    // nucbox and cups link to each other: the two badges share a height unless one steps aside.
    for (const [index, left] of badges.entries()) {
      for (const right of badges.slice(index + 1)) {
        expect(Math.abs(left.x - right.x) >= 34 || Math.abs(left.y - right.y) >= 24).toBe(true);
      }
    }
  });
});

describe("fitFleetLayout", () => {
  it.each([
    { label: "a small fleet is enlarged, up to a cap", graph: oneHost(1), scale: 1.25 },
    { label: "seven machines fill the canvas width", graph: oneHost(6), scale: 1.25 },
    { label: "forty-six machines shrink to fit", graph: oneHost(45), scale: null },
  ])("$label", ({ graph, scale }) => {
    const layout = layoutFleetGraph(graph);
    const width = 1320;
    const height = fleetCanvasHeight(layout, width, { min: 240, max: 640 });
    const view = fitFleetLayout(layout, { width, height });
    if (scale !== null) expect(view.scale).toBe(scale);
    // Centred, whole, and with room around it.
    expect(view.x).toBeCloseTo(width - view.x - layout.width * view.scale);
    expect(view.y).toBeCloseTo(height - view.y - layout.height * view.scale);
    expect(view.x).toBeGreaterThanOrEqual(36);
    expect(view.y).toBeGreaterThanOrEqual(36);
    expect(height).toBeGreaterThanOrEqual(240);
    expect(height).toBeLessThanOrEqual(640);
  });

  it("shows all of a fleet too tall for the manual zoom range, and zooming out does not jump", () => {
    const tall = { width: 400, height: 1572 };
    const view = fitFleetLayout(tall, { width: 800, height: 360 });
    expect(view.scale).toBeLessThan(0.3);
    expect(tall.height * view.scale).toBeLessThanOrEqual(360);
    expect(zoomFleetView(view, 0.8, { x: 0, y: 0 }).scale).toBe(view.scale);
    expect(zoomFleetView(view, 1.25, { x: 0, y: 0 }).scale).toBeGreaterThan(view.scale);
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
