import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { peerLinkHealth, type PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  AuthMcpClientAccess,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type PeerLinkSummary,
} from "@t3tools/contracts";
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
 * What a node reaches and what reaches it, one hop only, plus how this client gets there. A link
 * does not chain: A linked to B and B linked to C gives A's agents nothing on C, so following
 * links further would lie.
 */
export function fleetNeighborhood(graph: FleetGraph, focus: FleetFocus): FleetNeighborhood {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const sources = new Set<string>();
  for (const edge of graph.edges) {
    const touches =
      focus.kind === "edge" ? edge.id === focus.id : edge.from === focus.id || edge.to === focus.id;
    if (!touches) continue;
    edges.add(edge.id);
    nodes.add(edge.from).add(edge.to);
    if (edge.kind === "link" && (focus.kind === "edge" || edge.to === focus.id)) {
      sources.add(edge.from);
    }
  }
  // The client reaches the focus through whichever environment holds the link to it.
  for (const edge of graph.edges) {
    if (edge.kind !== "connection" || !sources.has(edge.to)) continue;
    edges.add(edge.id);
    nodes.add(edge.from);
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

/** Changes exactly when the layout would: membership, labels and access that order a bay, and wiring. */
export function fleetShapeKey(graph: FleetGraph): string {
  return [
    ...graph.nodes.map((node) => `${node.kind}\u0000${node.id}\u0000${node.label}`),
    ...graph.edges.map((edge) =>
      edge.kind === "link" ? `${edge.id}\u0000${edge.link.access}` : edge.id,
    ),
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
  /** Where a link between two drawn machines shows its access. Connections have none. */
  readonly badge: { readonly x: number; readonly y: number } | null;
}

/**
 * The machines only one environment reaches, at one access level. They share a tray and one
 * line from that environment, so forty machines under one host cost a line per level, not forty.
 */
export interface FleetLane {
  readonly id: string;
  readonly parentId: string;
  readonly access: AuthMcpClientAccess;
  readonly memberIds: ReadonlyArray<string>;
  /** The links this lane's line stands for, in member order. */
  readonly edgeIds: ReadonlyArray<string>;
  readonly rect: FleetRect;
  /** Where the level's name goes, left of the machines. */
  readonly label: FleetRect;
  readonly d: string;
  readonly arrow: { readonly x: number; readonly y: number };
}

export interface FleetLayout {
  readonly nodes: ReadonlyMap<string, FleetRect>;
  /** Connections and individually routed links. A lane's links are drawn by the lane. */
  readonly edges: ReadonlyMap<string, FleetEdgeGeometry>;
  readonly lanes: ReadonlyArray<FleetLane>;
  readonly width: number;
  readonly height: number;
}

const CLIENT = { width: 136, height: 36 };
const CARD = { width: 204, height: 56 };
const CHIP = { width: 128, height: 28 };
const SPINE_GAP = 72;
const GROUP_GAP = 32;
const BRACKET_FIRST = 20;
const BRACKET_STEP = 12;
const TRUNK = 20;
const FAN = 76;
const ARROW_LENGTH = 6;
const LANE_PAD = 8;
const LANE_LABEL = 144;
const LANE_GAP = 8;
const CHIP_GAP = 6;
const MAX_BAY_COLUMNS = 6;
const PORT_OFFSET = 12;
const CORNER = 8;
const BADGE = { width: 34, height: 24 };

const ACCESS_ORDER = AuthMcpClientAccess.literals;

/** Wide enough that a big bay stays near the canvas's shape, never wider than its fullest lane. */
const bayColumns = (total: number, fullestLane: number) =>
  Math.max(1, Math.min(fullestLane, MAX_BAY_COLUMNS, Math.ceil(Math.sqrt(total / 2.2))));

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
 * only through a link. Each of those sits beside the first environment that links to it, in a
 * lane per access level with the most access on top, and one trunk fans out to the lanes.
 * Positions come from the graph alone, so the same fleet always draws the same map.
 */
export function layoutFleetGraph(graph: FleetGraph): FleetLayout {
  const nodes = new Map<string, FleetRect>();
  const edges = new Map<string, FleetEdgeGeometry>();
  const lanes: FleetLane[] = [];
  const links = graph.edges.filter(isLinkEdge);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const environments = graph.nodes.filter((node) => node.kind === "environment");
  const environmentIds = new Set(environments.map((node) => node.id));

  const bayOf = new Map<string, FleetLinkEdge[]>();
  const homed = new Set<string>();
  for (const link of links) {
    if (byId.get(link.to)?.kind !== "target" || homed.has(link.to)) continue;
    homed.add(link.to);
    bayOf.set(link.from, [...(bayOf.get(link.from) ?? []), link]);
  }

  const sameColumn = links.filter((link) => environmentIds.has(link.to));
  const cardX = CLIENT.width + SPINE_GAP;
  const cardRight = cardX + CARD.width;
  const channelWidth =
    sameColumn.length === 0 ? 0 : BRACKET_FIRST + BRACKET_STEP * (sameColumn.length - 1);
  const splitX = cardRight + channelWidth + TRUNK;
  const bayX = splitX + FAN;
  const chipX0 = bayX + LANE_PAD + LANE_LABEL;
  const rowPitch = CHIP.height + CHIP_GAP;

  let y = 0;
  let width = cardRight + channelWidth;
  const inLane = new Set<string>();
  for (const environment of environments) {
    const bay = bayOf.get(environment.id) ?? [];
    const groups = ACCESS_ORDER.toReversed()
      .map((access) => ({
        access,
        members: bay
          .filter((link) => link.link.access === access)
          .toSorted(
            (left, right) =>
              labelOrder.compare(byId.get(left.to)?.label ?? "", byId.get(right.to)?.label ?? "") ||
              (left.to < right.to ? -1 : 1),
          ),
      }))
      .filter((group) => group.members.length > 0);
    const columns = bayColumns(bay.length, Math.max(0, ...groups.map((g) => g.members.length)));
    const laneHeight = (count: number) =>
      LANE_PAD * 2 + Math.ceil(count / columns) * rowPitch - CHIP_GAP;
    const bayHeight =
      groups.reduce((sum, group) => sum + laneHeight(group.members.length) + LANE_GAP, 0) -
      (groups.length === 0 ? 0 : LANE_GAP);
    const laneWidth = LANE_PAD * 2 + LANE_LABEL + columns * (CHIP.width + CHIP_GAP) - CHIP_GAP;
    const groupHeight = Math.max(CARD.height, bayHeight);
    const centerY = y + groupHeight / 2;
    nodes.set(environment.id, {
      x: cardX,
      y: centerY - CARD.height / 2,
      width: CARD.width,
      height: CARD.height,
    });

    let laneY = centerY - bayHeight / 2;
    for (const group of groups) {
      const height = laneHeight(group.members.length);
      const laneCenter = laneY + height / 2;
      group.members.forEach((link, index) => {
        inLane.add(link.id);
        nodes.set(link.to, {
          x: chipX0 + (index % columns) * (CHIP.width + CHIP_GAP),
          y: laneY + LANE_PAD + Math.floor(index / columns) * rowPitch,
          width: CHIP.width,
          height: CHIP.height,
        });
      });
      const endX = bayX - ARROW_LENGTH;
      const bend = (endX - splitX) * 0.55;
      lanes.push({
        id: `lane:${environment.id}:${group.access}`,
        parentId: environment.id,
        access: group.access,
        memberIds: group.members.map((link) => link.to),
        edgeIds: group.members.map((link) => link.id),
        rect: { x: bayX, y: laneY, width: laneWidth, height },
        label: { x: bayX + LANE_PAD, y: laneY, width: LANE_LABEL - LANE_PAD, height },
        d:
          `M${cardRight} ${centerY}H${splitX}` +
          `C${splitX + bend} ${centerY} ${endX - bend} ${laneCenter} ${endX} ${laneCenter}`,
        arrow: { x: bayX, y: laneCenter },
      });
      laneY += height + LANE_GAP;
    }
    if (groups.length > 0) width = Math.max(width, bayX + laneWidth);
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

  // Two links between the same pair run side by side, so the second badge steps below the first.
  const badges: Array<{ readonly x: number; readonly y: number }> = [];
  const placeBadge = (x: number, startY: number) => {
    let badgeY = startY;
    while (
      badges.some(
        (other) => Math.abs(other.x - x) < BADGE.width && Math.abs(other.y - badgeY) < BADGE.height,
      )
    ) {
      badgeY += BADGE.height;
    }
    const badge = { x, y: badgeY };
    badges.push(badge);
    return badge;
  };

  // Shorter spans take the inner brackets, so they nest instead of crossing.
  const span = (link: FleetLinkEdge) => Math.abs(centerOf(link.to) - centerOf(link.from));
  sameColumn
    .toSorted((left, right) => span(left) - span(right) || (left.id < right.id ? -1 : 1))
    .forEach((link, index) => {
      const bracketX = cardRight + BRACKET_FIRST + index * BRACKET_STEP;
      const fromY = centerOf(link.from) - PORT_OFFSET;
      const toY = centerOf(link.to) + PORT_OFFSET;
      edges.set(link.id, {
        d: elbowPath(cardRight, fromY, bracketX, cardRight + ARROW_LENGTH, toY),
        arrow: { x: cardRight, y: toY, dir: -1 },
        badge: placeBadge(bracketX, (fromY + toY) / 2),
      });
    });

  // A machine in one environment's bay that a second environment also links to.
  for (const link of links) {
    if (environmentIds.has(link.to) || inLane.has(link.id)) continue;
    const target = nodes.get(link.to)!;
    const fromY = centerOf(link.from) - PORT_OFFSET;
    const toY = target.y + target.height / 2;
    const endX = target.x - ARROW_LENGTH;
    const reach = Math.max(40, (endX - cardRight) / 2);
    edges.set(link.id, {
      d: `M${cardRight} ${fromY}C${cardRight + reach} ${fromY} ${endX - reach} ${toY} ${endX} ${toY}`,
      arrow: { x: target.x, y: toY, dir: 1 },
      badge: placeBadge((cardRight + target.x) / 2, (fromY + toY) / 2),
    });
  }

  return { nodes, edges, lanes, width, height };
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
/** A small fleet is enlarged to fill the canvas, but not until three machines look like a poster. */
const FLEET_FIT_MAX_SCALE = 1.25;
const FLEET_FIT_PADDING = 36;

const fitScale = (available: number, extent: number) =>
  Math.max(0.01, (available - FLEET_FIT_PADDING * 2) / Math.max(1, extent));

/** Centers the whole map in the viewport at the largest scale that shows all of it. */
export function fitFleetLayout(
  layout: Pick<FleetLayout, "width" | "height">,
  viewport: { readonly width: number; readonly height: number },
): FleetViewTransform {
  const scale = Math.min(
    FLEET_FIT_MAX_SCALE,
    fitScale(viewport.width, layout.width),
    fitScale(viewport.height, layout.height),
  );
  return {
    scale,
    x: (viewport.width - layout.width * scale) / 2,
    y: (viewport.height - layout.height * scale) / 2,
  };
}

/** How tall the canvas wants to be at this width: the fitted map plus padding, within bounds. */
export function fleetCanvasHeight(
  layout: Pick<FleetLayout, "width" | "height">,
  width: number,
  bounds: { readonly min: number; readonly max: number },
): number {
  const scale = Math.min(FLEET_FIT_MAX_SCALE, fitScale(width, layout.width));
  const wanted = Math.ceil(layout.height * scale + FLEET_FIT_PADDING * 2);
  return Math.max(bounds.min, Math.min(bounds.max, wanted));
}

/** Zooms by `factor`, keeping the map point under `anchor` where it is. */
export function zoomFleetView(
  view: FleetViewTransform,
  factor: number,
  anchor: { readonly x: number; readonly y: number },
): FleetViewTransform {
  // A fit of a very large fleet can sit below the manual minimum; zooming out must not jump up.
  const floor = Math.min(FLEET_MIN_SCALE, view.scale);
  const scale = Math.max(floor, Math.min(FLEET_MAX_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}
