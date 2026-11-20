import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { peerLinkHealth, type PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId, EnvironmentMachineKind, PeerLinkSummary } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export const FLEET_CLIENT_NODE_ID = "client";

/** What this client knows of the links an environment holds to others. */
export type FleetOutgoingLinks =
  | { readonly state: "loaded"; readonly links: ReadonlyArray<PeerLinkSummary> }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  /** Connected, but linked environments is off or unsupported there. */
  | { readonly state: "off" }
  /** Not connected, or not allowed to read: it may hold links this client cannot see. */
  | { readonly state: "unknown" };

export interface FleetEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind | null;
  readonly phase: EnvironmentConnectionPhase;
  readonly outgoing: FleetOutgoingLinks;
}

export type FleetNode =
  | { readonly id: string; readonly kind: "client"; readonly label: string }
  | {
      readonly id: string;
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly machine: EnvironmentMachineKind | null;
      readonly phase: EnvironmentConnectionPhase;
      readonly outgoing: FleetOutgoingLinks["state"];
      readonly outgoingError: string | null;
    }
  /** Seen only as another environment's link target; the client is not connected to it. */
  | {
      readonly id: string;
      readonly kind: "target";
      readonly environmentId: EnvironmentId;
      readonly label: string;
    };

export type FleetEdge =
  | {
      readonly id: string;
      readonly kind: "connection";
      readonly from: string;
      readonly to: string;
      readonly connected: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "link";
      readonly from: string;
      readonly to: string;
      readonly sourceEnvironmentId: EnvironmentId;
      readonly link: PeerLinkSummary;
      readonly health: PeerLinkHealth;
    };

export type FleetLinkEdge = Extract<FleetEdge, { kind: "link" }>;

export interface FleetGraph {
  readonly nodes: ReadonlyArray<FleetNode>;
  readonly edges: ReadonlyArray<FleetEdge>;
}

export const fleetEnvironmentNodeId = (environmentId: EnvironmentId) => `env:${environmentId}`;

/**
 * One node per machine however often it is named: an environment listed twice, a link repeated
 * in a list, and a link to an environment the client also knows all land on the same node.
 */
export function buildFleetGraph(input: {
  readonly clientLabel: string;
  readonly environments: ReadonlyArray<FleetEnvironmentInput>;
  readonly now: DateTime.Utc;
}): FleetGraph {
  const nodes = new Map<string, FleetNode>([
    [FLEET_CLIENT_NODE_ID, { id: FLEET_CLIENT_NODE_ID, kind: "client", label: input.clientLabel }],
  ]);
  const edges = new Map<string, FleetEdge>();
  const environments = input.environments.filter(
    (environment, index, all) =>
      all.findIndex((other) => other.environmentId === environment.environmentId) === index,
  );
  for (const environment of environments) {
    const id = fleetEnvironmentNodeId(environment.environmentId);
    nodes.set(id, {
      id,
      kind: "environment",
      environmentId: environment.environmentId,
      label: environment.label,
      machine: environment.machine,
      phase: environment.phase,
      outgoing: environment.outgoing.state,
      outgoingError: environment.outgoing.state === "error" ? environment.outgoing.message : null,
    });
    edges.set(`conn:${id}`, {
      id: `conn:${id}`,
      kind: "connection",
      from: FLEET_CLIENT_NODE_ID,
      to: id,
      connected: environment.phase === "connected",
    });
  }
  for (const environment of environments) {
    if (environment.outgoing.state !== "loaded") continue;
    const from = fleetEnvironmentNodeId(environment.environmentId);
    for (const link of environment.outgoing.links) {
      const to = fleetEnvironmentNodeId(link.environmentId);
      const id = `link:${from}>${to}`;
      if (to === from || edges.has(id)) continue;
      if (!nodes.has(to)) {
        nodes.set(to, {
          id: to,
          kind: "target",
          environmentId: link.environmentId,
          label: link.label,
        });
      }
      edges.set(id, {
        id,
        kind: "link",
        from,
        to,
        sourceEnvironmentId: environment.environmentId,
        link,
        health: peerLinkHealth(link, input.now),
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export type FleetFocus =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string };

export interface FleetNeighborhood {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/**
 * What a node reaches and what reaches it, one hop only. A link does not chain: A linked to B
 * and B linked to C gives A's agents nothing on C, so following links further would lie.
 */
export function fleetNeighborhood(graph: FleetGraph, focus: FleetFocus): FleetNeighborhood {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    const touches =
      focus.kind === "edge" ? edge.id === focus.id : edge.from === focus.id || edge.to === focus.id;
    if (!touches) continue;
    edges.add(edge.id);
    nodes.add(edge.from).add(edge.to);
  }
  if (focus.kind === "node" && graph.nodes.some((node) => node.id === focus.id)) {
    nodes.add(focus.id);
  }
  return { nodes, edges };
}

export const isLinkEdge = (edge: FleetEdge): edge is FleetLinkEdge => edge.kind === "link";

/** Whether a link wants the user's attention: anything but reachable with time left. */
export const linkNeedsAttention = (health: PeerLinkHealth) =>
  health.kind !== "reachable" || health.expiresInDays !== null;

/** Changes exactly when the layout would: membership, labels that order a bay, and wiring. */
export function fleetShapeKey(graph: FleetGraph): string {
  return [
    ...graph.nodes.map((node) => `${node.kind}\u0000${node.id}\u0000${node.label}`),
    ...graph.edges.map((edge) => edge.id),
  ].join("\n");
}

export interface FleetRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FleetEdgeGeometry {
  readonly d: string;
  /** Arrowhead tip and the horizontal direction it points. Connections have none. */
  readonly arrow: { readonly x: number; readonly y: number; readonly dir: 1 | -1 } | null;
  /** Where an individually routed link shows its access; null where the target chip shows it. */
  readonly badge: { readonly x: number; readonly y: number } | null;
}

/** The shared wiring from one environment to the bay of machines only it reaches. */
export interface FleetHarness {
  readonly parentId: string;
  readonly memberIds: ReadonlyArray<string>;
  readonly d: string;
}

export interface FleetLayout {
  readonly nodes: ReadonlyMap<string, FleetRect>;
  readonly edges: ReadonlyMap<string, FleetEdgeGeometry>;
  readonly harnesses: ReadonlyArray<FleetHarness>;
  readonly width: number;
  readonly height: number;
}

const CLIENT = { width: 148, height: 44 };
const CARD = { width: 184, height: 52 };
const CHIP = { width: 128, height: 28 };
const SPINE_GAP = 64;
const GROUP_GAP = 28;
const LANE_FIRST = 20;
const LANE_STEP = 12;
const BAY_GAP = 36;
const RAIL_INSET = 6;
const CHIP_INSET = 22;
const CHIP_ROW_GAP = 8;
const BUS_HEIGHT = 14;
const PORT_OFFSET = 12;
const CORNER = 8;

const bayColumns = (count: number) => (count <= 3 ? 1 : count <= 8 ? 2 : count <= 18 ? 3 : 4);

const labelOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Horizontal, a vertical run at `viaX`, then horizontal again, with rounded turns. */
function elbowPath(x0: number, y0: number, viaX: number, x1: number, y1: number): string {
  const dy = y1 - y0;
  if (Math.abs(dy) < 1) return `M${x0} ${y0}H${x1}`;
  const r = Math.min(CORNER, Math.abs(dy) / 2, Math.abs(viaX - x0), Math.abs(x1 - viaX));
  const sy = Math.sign(dy);
  const inX = Math.sign(viaX - x0);
  const outX = Math.sign(x1 - viaX);
  return [
    `M${x0} ${y0}`,
    `H${viaX - inX * r}`,
    `Q${viaX} ${y0} ${viaX} ${y0 + sy * r}`,
    `V${y1 - sy * r}`,
    `Q${viaX} ${y1} ${viaX + outX * r} ${y1}`,
    `H${x1}`,
  ].join("");
}

/**
 * Three columns, left to right: this client, the environments it knows, and the machines seen
 * only through a link. Each of those sits in a bay beside the first environment that links to
 * it, wired from one trunk so forty machines under one host cost one line, not forty. Positions
 * come from the graph alone, so the same fleet always draws the same map.
 */
export function layoutFleetGraph(graph: FleetGraph): FleetLayout {
  const nodes = new Map<string, FleetRect>();
  const edges = new Map<string, FleetEdgeGeometry>();
  const harnesses: FleetHarness[] = [];
  const links = graph.edges.filter(isLinkEdge);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const environments = graph.nodes.filter((node) => node.kind === "environment");
  const environmentIds = new Set(environments.map((node) => node.id));

  const bayOf = new Map<string, string[]>();
  const homed = new Set<string>();
  for (const link of links) {
    if (byId.get(link.to)?.kind !== "target" || homed.has(link.to)) continue;
    homed.add(link.to);
    bayOf.set(link.from, [...(bayOf.get(link.from) ?? []), link.to]);
  }

  const sameColumn = links.filter((link) => environmentIds.has(link.to));
  const cardX = CLIENT.width + SPINE_GAP;
  const cardRight = cardX + CARD.width;
  const channelWidth =
    sameColumn.length === 0 ? 0 : LANE_FIRST + LANE_STEP * (sameColumn.length - 1);
  const bayX = cardRight + channelWidth + BAY_GAP;

  let y = 0;
  let width = cardRight + channelWidth;
  const stubs = new Set<string>();
  for (const environment of environments) {
    const members = (bayOf.get(environment.id) ?? []).toSorted(
      (left, right) =>
        labelOrder.compare(byId.get(left)?.label ?? "", byId.get(right)?.label ?? "") ||
        (left < right ? -1 : 1),
    );
    const columns = members.length === 0 ? 0 : bayColumns(members.length);
    const rows = columns === 0 ? 0 : Math.ceil(members.length / columns);
    const busHeight = columns > 1 ? BUS_HEIGHT : 0;
    const rowPitch = CHIP.height + CHIP_ROW_GAP;
    const bayHeight = rows === 0 ? 0 : busHeight + rows * rowPitch - CHIP_ROW_GAP;
    const groupHeight = Math.max(CARD.height, bayHeight);
    const centerY = y + groupHeight / 2;
    nodes.set(environment.id, {
      x: cardX,
      y: centerY - CARD.height / 2,
      width: CARD.width,
      height: CARD.height,
    });

    if (columns > 0) {
      const bayTop = centerY - bayHeight / 2;
      const columnPitch = CHIP_INSET + CHIP.width;
      const chipCenterY = (row: number) => bayTop + busHeight + row * rowPitch + CHIP.height / 2;
      const railX = (column: number) => bayX + column * columnPitch + RAIL_INSET;
      const lastRowOf = (column: number) => Math.ceil((members.length - column) / columns) - 1;
      members.forEach((id, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const chipX = bayX + column * columnPitch + CHIP_INSET;
        nodes.set(id, {
          x: chipX,
          y: chipCenterY(row) - CHIP.height / 2,
          width: CHIP.width,
          height: CHIP.height,
        });
        const stub = `link:${environment.id}>${id}`;
        stubs.add(stub);
        edges.set(stub, {
          d: `M${railX(column)} ${chipCenterY(row)}H${chipX}`,
          arrow: { x: chipX, y: chipCenterY(row), dir: 1 },
          badge: null,
        });
      });
      const wires = [`M${cardRight} ${centerY}H${railX(0)}`];
      if (columns === 1) {
        if (rows > 1) wires.push(`M${railX(0)} ${chipCenterY(0)}V${chipCenterY(rows - 1)}`);
      } else {
        const busY = bayTop + CORNER / 2;
        const first = railX(0);
        const last = railX(columns - 1);
        wires.push(
          `M${first} ${chipCenterY(lastRowOf(0))}V${busY + CORNER}Q${first} ${busY} ${first + CORNER} ${busY}` +
            `H${last - CORNER}Q${last} ${busY} ${last} ${busY + CORNER}V${chipCenterY(lastRowOf(columns - 1))}`,
        );
        for (let column = 1; column < columns - 1; column += 1) {
          wires.push(`M${railX(column)} ${busY}V${chipCenterY(lastRowOf(column))}`);
        }
      }
      harnesses.push({ parentId: environment.id, memberIds: members, d: wires.join("") });
      width = Math.max(width, bayX + columns * columnPitch);
    }
    y += groupHeight + GROUP_GAP;
  }
  const height = Math.max(CLIENT.height, y - GROUP_GAP);

  const cardCenters = environments.map((environment) => {
    const rect = nodes.get(environment.id)!;
    return rect.y + rect.height / 2;
  });
  const clientCenterY =
    cardCenters.length === 0 ? height / 2 : (cardCenters[0]! + cardCenters.at(-1)!) / 2;
  nodes.set(FLEET_CLIENT_NODE_ID, {
    x: 0,
    y: clientCenterY - CLIENT.height / 2,
    width: CLIENT.width,
    height: CLIENT.height,
  });

  const centerOf = (id: string) => {
    const rect = nodes.get(id)!;
    return rect.y + rect.height / 2;
  };
  for (const edge of graph.edges) {
    if (edge.kind !== "connection") continue;
    edges.set(edge.id, {
      d: elbowPath(
        CLIENT.width,
        clientCenterY,
        CLIENT.width + SPINE_GAP / 2,
        cardX,
        centerOf(edge.to),
      ),
      arrow: null,
      badge: null,
    });
  }

  // Shorter spans take the inner lanes, so brackets nest instead of crossing.
  const span = (link: FleetLinkEdge) => Math.abs(centerOf(link.to) - centerOf(link.from));
  sameColumn
    .toSorted((left, right) => span(left) - span(right) || (left.id < right.id ? -1 : 1))
    .forEach((link, lane) => {
      const laneX = cardRight + LANE_FIRST + lane * LANE_STEP;
      const fromY = centerOf(link.from) - PORT_OFFSET;
      const toY = centerOf(link.to) + PORT_OFFSET;
      edges.set(link.id, {
        d: elbowPath(cardRight, fromY, laneX, cardRight, toY),
        arrow: { x: cardRight, y: toY, dir: -1 },
        badge: { x: laneX, y: (fromY + toY) / 2 },
      });
    });

  // A machine in one environment's bay that a second environment also links to.
  for (const link of links) {
    if (environmentIds.has(link.to) || stubs.has(link.id)) continue;
    const target = nodes.get(link.to)!;
    const fromY = centerOf(link.from) - PORT_OFFSET;
    const toY = target.y + target.height / 2;
    const reach = Math.max(40, (target.x - cardRight) / 2);
    edges.set(link.id, {
      d: `M${cardRight} ${fromY}C${cardRight + reach} ${fromY} ${target.x - reach} ${toY} ${target.x} ${toY}`,
      arrow: { x: target.x, y: toY, dir: 1 },
      badge: { x: (cardRight + target.x) / 2, y: (fromY + toY) / 2 },
    });
  }

  return { nodes, edges, harnesses, width, height };
}

export type FleetDirection = "up" | "down" | "left" | "right";

/** The nearest node in that direction, for arrow keys. Sideways distance counts double. */
export function nextFleetNode(
  layout: FleetLayout,
  fromId: string,
  direction: FleetDirection,
): string | null {
  const from = layout.nodes.get(fromId);
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const center = (rect: FleetRect) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const origin = center(from);
  let best: { readonly id: string; readonly score: number } | null = null;
  for (const [id, rect] of layout.nodes) {
    if (id === fromId) continue;
    const point = center(rect);
    const along = sign * (horizontal ? point.x - origin.x : point.y - origin.y);
    const across = Math.abs(horizontal ? point.y - origin.y : point.x - origin.x);
    if (along < 1) continue;
    const score = along + across * 2;
    if (best === null || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

export interface FleetViewTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const FLEET_MIN_SCALE = 0.3;
const FLEET_MAX_SCALE = 2;

/** Centers the whole map in the viewport, shrinking to fit but never enlarging past 1:1. */
export function fitFleetLayout(
  layout: Pick<FleetLayout, "width" | "height">,
  viewport: { readonly width: number; readonly height: number },
  padding = 32,
): FleetViewTransform {
  const scale = Math.max(
    FLEET_MIN_SCALE,
    Math.min(
      1,
      (viewport.width - padding * 2) / Math.max(1, layout.width),
      (viewport.height - padding * 2) / Math.max(1, layout.height),
    ),
  );
  return {
    scale,
    x: (viewport.width - layout.width * scale) / 2,
    y: (viewport.height - layout.height * scale) / 2,
  };
}

/** Zooms by `factor`, keeping the map point under `anchor` where it is. */
export function zoomFleetView(
  view: FleetViewTransform,
  factor: number,
  anchor: { readonly x: number; readonly y: number },
): FleetViewTransform {
  const scale = Math.max(FLEET_MIN_SCALE, Math.min(FLEET_MAX_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}
