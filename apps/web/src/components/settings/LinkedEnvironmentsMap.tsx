import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import type { PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  AuthMcpClientAccess,
  type EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useGT, useMessages } from "gt-react";
import {
  AppWindowIcon,
  ClockAlertIcon,
  GlobeIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { peerLinkEnvironment, peerLinkListsAtom } from "~/state/peerLinks";
import { formatEnvironmentQueryError } from "~/state/query";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";
import {
  LinkEnvironmentAction,
  peerLinkStatusText,
  useForgetPeerLink,
} from "./LinkedEnvironmentsSettings";
import {
  buildFleetGraph,
  fitFleetLayout,
  FLEET_CLIENT_NODE_ID,
  fleetEnvironmentNodeId,
  fleetNeighborhood,
  fleetShapeKey,
  type FleetDirection,
  type FleetEdge,
  type FleetEnvironmentInput,
  type FleetFocus,
  type FleetGraph,
  type FleetLayout,
  type FleetLinkEdge,
  type FleetNode,
  type FleetRect,
  type FleetViewTransform,
  isLinkEdge,
  layoutFleetGraph,
  linkNeedsAttention,
  nextFleetNode,
  zoomFleetView,
} from "./linkedEnvironmentsMap.logic";

type GT = ReturnType<typeof useGT>;
type Messages = ReturnType<typeof useMessages>;
type EnvironmentHost = EnvironmentPresentation;

const ACCESS_LEVELS = AuthMcpClientAccess.literals;
const accessLevel = (access: AuthMcpClientAccess) => ACCESS_LEVELS.indexOf(access);
const LINK_STROKE_WIDTHS = [1.25, 1.75, 2.25, 2.75, 3.25];
const ARROW_ROVE: Record<string, FleetDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Colour says how a link is doing; a healthy one stays neutral so trouble stands out. */
function healthTone(health: PeerLinkHealth): string {
  if (health.kind === "expired" || health.kind === "failing") return "text-destructive";
  if (health.kind === "unreachable") return "text-muted-foreground";
  return health.expiresInDays === null ? "text-foreground/70" : "text-warning";
}

/** Dashes repeat the same message without colour: broken for unreachable, dotted for expired. */
function healthDash(health: PeerLinkHealth): string | undefined {
  if (health.kind === "expired") return "1 5";
  return health.kind === "unreachable" || health.kind === "failing" ? "5 4" : undefined;
}

function healthLabel(health: PeerLinkHealth, gt: GT): string {
  switch (health.kind) {
    case "expired":
      return gt("Expired", { $context: "status of a link between two machines" });
    case "unreachable":
      return gt("Not answering");
    case "failing":
      return gt("Failing", { $context: "status of a link between two machines" });
    case "reachable":
      return health.expiresInDays === null
        ? gt("Reachable")
        : gt("{days, plural, one {Expires in {days} day} other {Expires in {days} days}}", {
            days: health.expiresInDays,
          });
  }
}

/** Five rising bars, filled up to the access a link grants: read only is one, full access five. */
function AccessMeter({ access, className }: { access: AuthMcpClientAccess; className?: string }) {
  const level = accessLevel(access);
  return (
    <svg aria-hidden viewBox="0 0 19 12" className={cn("h-3 w-[19px] shrink-0", className)}>
      {ACCESS_LEVELS.map((step, index) => (
        <rect
          key={step}
          x={index * 4}
          y={8 - index * 2}
          width="3"
          height={4 + index * 2}
          rx="0.75"
          fill="currentColor"
          opacity={index <= level ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

function HealthGlyph({ health }: { health: PeerLinkHealth }) {
  const tone = healthTone(health);
  if (health.kind === "expired") return <XIcon aria-hidden className={cn("size-3", tone)} />;
  if (health.kind === "failing") {
    return <TriangleAlertIcon aria-hidden className={cn("size-3", tone)} />;
  }
  if (health.kind === "unreachable") {
    return <span aria-hidden className="size-2 rounded-full border border-muted-foreground" />;
  }
  return health.expiresInDays === null ? (
    <span aria-hidden className="size-2 rounded-full bg-success forced-colors:border-4" />
  ) : (
    <ClockAlertIcon aria-hidden className={cn("size-3", tone)} />
  );
}

function useFleetGraph(hosts: ReadonlyArray<EnvironmentHost>) {
  const gt = useGT();
  const m = useMessages();
  const { environments } = useEnvironments();
  const nowMinute = useNowMinute();
  const lists = useAtomValue(
    peerLinkListsAtom(environmentIdsKey(hosts.map((host) => host.environmentId))),
  );
  const listByHost = new Map(hosts.map((host, index) => [host.environmentId, lists[index]]));
  const inputs = environments.map((environment): FleetEnvironmentInput => {
    const list = listByHost.get(environment.environmentId);
    const connected = environment.connection.phase === "connected";
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      machine: environment.serverConfig
        ? resolveEnvironmentMachineKind(environment.serverConfig)
        : null,
      phase: environment.connection.phase,
      outgoing:
        list === undefined
          ? {
              state:
                connected && !offersLinkedEnvironments(environment.serverConfig)
                  ? "off"
                  : "unknown",
            }
          : list._tag === "Success"
            ? { state: "loaded", links: list.value.links }
            : list._tag === "Failure"
              ? { state: "error", message: formatEnvironmentQueryError(list.cause, m) }
              : { state: "loading" },
    };
  });
  const graph = buildFleetGraph({
    clientLabel: isElectron ? gt("This device") : gt("This browser"),
    environments: inputs,
    now: DateTime.makeUnsafe(nowMinute),
  });
  return { graph, environments };
}

/** The layout for the graph's current shape; a health or status change reuses the last one. */
function useFleetLayout(graph: FleetGraph) {
  const key = fleetShapeKey(graph);
  const [laid, setLaid] = useState(() => ({ key, layout: layoutFleetGraph(graph) }));
  if (laid.key === key) return laid;
  const next = { key, layout: layoutFleetGraph(graph) };
  setLaid(next);
  return next;
}

export function LinkedEnvironmentsMap({
  hosts,
}: {
  readonly hosts: ReadonlyArray<EnvironmentHost>;
}) {
  const { graph, environments } = useFleetGraph(hosts);
  const { key, layout } = useFleetLayout(graph);
  const [picked, setPicked] = useState<FleetFocus | null>(null);
  const selection =
    picked === null
      ? null
      : (picked.kind === "node" ? graph.nodes : graph.edges).some((item) => item.id === picked.id)
        ? picked
        : null;
  return (
    <>
      <FleetCanvas
        graph={graph}
        layout={layout}
        shapeKey={key}
        environments={environments}
        selection={selection}
        onSelect={setPicked}
      />
      <FleetInspector
        graph={graph}
        hosts={hosts}
        environments={environments}
        selection={selection}
        onSelect={setPicked}
      />
    </>
  );
}

interface FleetSceneProps {
  readonly graph: FleetGraph;
  readonly layout: FleetLayout;
  readonly environments: ReadonlyArray<EnvironmentHost>;
  readonly selection: FleetFocus | null;
  readonly onSelect: (focus: FleetFocus | null) => void;
}

function FleetCanvas({ shapeKey, ...scene }: FleetSceneProps & { readonly shapeKey: string }) {
  const gt = useGT();
  const { layout, onSelect } = scene;
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  // A view the user set by hand holds until the map's shape changes; otherwise it fits itself.
  const [manual, setManual] = useState<{
    readonly key: string;
    readonly view: FleetViewTransform;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    readonly x: number;
    readonly y: number;
    readonly origin: FleetViewTransform;
    moved: boolean;
  } | null>(null);
  const view =
    manual?.key === shapeKey ? manual.view : size === null ? null : fitFleetLayout(layout, size);
  const setView = (next: FleetViewTransform) => setManual({ key: shapeKey, view: next });
  const zoom = (factor: number, anchor?: { readonly x: number; readonly y: number }) => {
    if (view === null || size === null) return;
    setView(zoomFleetView(view, factor, anchor ?? { x: size.width / 2, y: size.height / 2 }));
  };
  const onWheel = useEffectEvent((event: WheelEvent) => {
    // Plain scrolling stays the page's; a pinch or Ctrl/Cmd + wheel zooms the map.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    zoom(Math.exp(-event.deltaY * 0.01), {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the canvas with ResizeObserver, and React's wheel listener is passive so it cannot stop the page zooming
  useEffect(() => {
    if (canvas === null) return;
    const stopObserving = observeResize(canvas, ([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((current) =>
        current?.width === width && current.height === height ? current : { width, height },
      );
    });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stopObserving();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas]);

  // Reads the view inside the updater so the scene's props stay the same while panning.
  const reveal = (rect: FleetRect) => {
    if (size === null) return;
    setManual((current) => {
      const shown = current?.key === shapeKey ? current.view : fitFleetLayout(layout, size);
      const left = rect.x * shown.scale + shown.x;
      const top = rect.y * shown.scale + shown.y;
      const inside =
        left >= 0 &&
        top >= 0 &&
        left + rect.width * shown.scale <= size.width &&
        top + rect.height * shown.scale <= size.height;
      if (inside) return current;
      return {
        key: shapeKey,
        view: {
          scale: shown.scale,
          x: size.width / 2 - (rect.x + rect.width / 2) * shown.scale,
          y: size.height / 2 - (rect.y + rect.height / 2) * shown.scale,
        },
      };
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || view === null) return;
    if ((event.target as Element).closest("[data-fleet-item],[data-fleet-controls]")) return;
    drag.current = { x: event.clientX, y: event.clientY, origin: view, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    if (!current.moved) setDragging(true);
    current.moved = true;
    setView({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy });
  };
  const endDrag = (cancelled: boolean) => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    setDragging(false);
    if (!current.moved && !cancelled) onSelect(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-") zoom(0.8);
    else if (event.key === "0") setManual(null);
    else if (event.key === "Escape") onSelect(null);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={setCanvas}
      data-dragging={dragging || undefined}
      className="relative h-[min(30rem,70vh)] min-h-72 cursor-grab touch-none overflow-clip rounded-t-xl bg-background/50 select-none data-dragging:cursor-grabbing"
      style={
        view === null
          ? undefined
          : {
              backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1.5px)",
              backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
              backgroundPosition: `${view.x}px ${view.y}px`,
            }
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(false)}
      onPointerCancel={() => endDrag(true)}
      onKeyDown={onKeyDown}
    >
      {view === null ? null : (
        <div
          className="absolute top-0 left-0 origin-top-left in-data-dragging:will-change-transform"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <FleetScene {...scene} onReveal={reveal} />
        </div>
      )}
      <div
        data-fleet-controls
        className="absolute top-2 right-2 flex cursor-default items-center gap-1 rounded-lg border border-border/60 bg-popover/90 p-0.5 shadow-xs/5"
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Zoom out")}
          onClick={() => zoom(0.8)}
        >
          <MinusIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Zoom in")}
          onClick={() => zoom(1.25)}
        >
          <PlusIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Fit the map to view")}
          disabled={manual?.key !== shapeKey}
          onClick={() => setManual(null)}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </div>
  );
}

function environmentStatusText(
  node: Extract<FleetNode, { kind: "environment" }>,
  environment: EnvironmentHost | undefined,
  linkCount: number,
  gt: GT,
  m: Messages,
): string {
  if (node.phase !== "connected") {
    const status = environment
      ? connectionStatusTitle(environment.connection, m)
      : gt("Not connected");
    return gt("{status}. Links unknown", { status });
  }
  switch (node.outgoing) {
    case "loading":
      return gt("Loading links…");
    case "error":
      return gt("Links could not be loaded");
    case "off":
      return gt("Linked environments is off");
    case "unknown":
      return gt("Links not readable from here");
    case "loaded":
      return gt("{count, plural, =0 {No links out} one {# link out} other {# links out}}", {
        count: linkCount,
      });
  }
}

function linkSummary(edge: FleetLinkEdge, gt: GT, m: Messages): string {
  return `${m(accessConfig[edge.link.access].label)}, ${healthLabel(edge.health, gt)}`;
}

const FleetScene = memo(function FleetScene({
  graph,
  layout,
  environments,
  selection,
  onSelect,
  onReveal,
}: FleetSceneProps & { readonly onReveal: (rect: FleetRect) => void }) {
  const gt = useGT();
  const m = useMessages();
  const [hover, setHover] = useState<FleetFocus | null>(null);
  const [roving, setRoving] = useState(FLEET_CLIENT_NODE_ID);
  const focus = hover ?? selection;
  const lit = focus === null ? null : fleetNeighborhood(graph, focus);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const environmentById = new Map(
    environments.map((environment) => [
      fleetEnvironmentNodeId(environment.environmentId),
      environment,
    ]),
  );
  const links = graph.edges.filter(isLinkEdge);
  const tabStop = layout.nodes.has(roving) ? roving : FLEET_CLIENT_NODE_ID;
  const isSelected = (kind: FleetFocus["kind"], id: string) =>
    selection?.kind === kind && selection.id === id;
  const fade = (dimmed: boolean) =>
    cn(
      "transition-opacity duration-150 motion-reduce:transition-none",
      dimmed && "opacity-25 forced-colors:opacity-50",
    );
  const hoverProps = (target: FleetFocus) => ({
    onPointerEnter: () => setHover(target),
    onPointerLeave: () => setHover(null),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_ROVE[event.key];
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-fleet-node]");
    if (direction === undefined || from === null) return;
    event.preventDefault();
    const next = nextFleetNode(layout, from.dataset.fleetNode ?? "", direction);
    const rect = next === null ? undefined : layout.nodes.get(next);
    if (next === null || rect === undefined) return;
    event.currentTarget
      .querySelector<HTMLElement>(`[data-fleet-node="${CSS.escape(next)}"]`)
      ?.focus({ preventScroll: true });
    onReveal(rect);
  };

  const nodeProps = (node: FleetNode, rect: FleetRect, label: string) => ({
    type: "button" as const,
    "data-fleet-item": "",
    "data-fleet-node": node.id,
    "aria-label": label,
    "aria-pressed": isSelected("node", node.id),
    tabIndex: node.id === tabStop ? 0 : -1,
    style: { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
    onClick: () => onSelect(isSelected("node", node.id) ? null : { kind: "node", id: node.id }),
    onFocus: () => {
      setRoving(node.id);
      setHover({ kind: "node", id: node.id });
    },
    onBlur: () => setHover(null),
    ...hoverProps({ kind: "node", id: node.id }),
  });
  const nodeClass = (id: string) =>
    cn(
      "absolute flex cursor-pointer items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-inset forced-colors:focus-visible:outline-2 forced-colors:aria-pressed:outline-2",
      fade(lit !== null && !lit.nodes.has(id)),
    );

  return (
    <div
      role="group"
      aria-label={gt("Map of linked environments")}
      aria-description={gt(
        "Arrow keys move between machines. Enter opens a machine's details, where its links are listed. Plus and minus zoom, zero fits the map.",
      )}
      onKeyDown={onKeyDown}
    >
      <svg
        width={layout.width}
        height={layout.height}
        className="absolute top-0 left-0 overflow-visible"
        fill="none"
        strokeLinecap="round"
      >
        {graph.edges.map((edge) => {
          const geometry = layout.edges.get(edge.id);
          if (edge.kind !== "connection" || geometry === undefined) return null;
          return (
            <path
              key={edge.id}
              d={geometry.d}
              stroke="currentColor"
              strokeWidth="1"
              strokeDasharray={edge.connected ? undefined : "2 5"}
              className={cn(
                "text-muted-foreground/70",
                fade(lit !== null && !lit.edges.has(edge.id)),
              )}
            />
          );
        })}
        {layout.harnesses.map((harness) => (
          <path
            key={harness.parentId}
            d={harness.d}
            stroke="currentColor"
            strokeWidth="1.5"
            className={cn(
              "text-foreground/45",
              fade(
                lit !== null &&
                  !(
                    lit.nodes.has(harness.parentId) &&
                    harness.memberIds.some((id) => lit.nodes.has(id))
                  ),
              ),
            )}
          />
        ))}
        {links.map((edge) => {
          const geometry = layout.edges.get(edge.id);
          if (geometry === undefined) return null;
          const { arrow } = geometry;
          const selected = isSelected("edge", edge.id);
          return (
            <g
              key={edge.id}
              className={cn(
                selected ? "text-primary" : healthTone(edge.health),
                fade(lit !== null && !lit.edges.has(edge.id)),
              )}
            >
              <path
                d={geometry.d}
                stroke="currentColor"
                // Selection also thickens the line, for when colour is forced.
                strokeWidth={
                  (LINK_STROKE_WIDTHS[accessLevel(edge.link.access)] ?? 2) + (selected ? 1 : 0)
                }
                strokeDasharray={healthDash(edge.health)}
              />
              {arrow ? (
                <path
                  d={`M${arrow.x - arrow.dir * 7} ${arrow.y - 4}L${arrow.x} ${arrow.y}L${arrow.x - arrow.dir * 7} ${arrow.y + 4}Z`}
                  fill="currentColor"
                />
              ) : null}
              {/* Pointer shortcut only: the badge or the target chip is the link's control. */}
              <path
                aria-hidden
                data-fleet-item=""
                d={geometry.d}
                stroke="transparent"
                strokeWidth="14"
                className="cursor-pointer"
                onClick={() => onSelect(selected ? null : { kind: "edge", id: edge.id })}
                {...hoverProps({ kind: "edge", id: edge.id })}
              />
            </g>
          );
        })}
      </svg>
      {links.map((edge) => {
        const badge = layout.edges.get(edge.id)?.badge;
        if (!badge) return null;
        const target = { kind: "edge", id: edge.id } as const;
        return (
          <button
            key={edge.id}
            type="button"
            data-fleet-item=""
            tabIndex={-1}
            aria-pressed={isSelected("edge", edge.id)}
            aria-label={gt("Link from {source} to {target}: {summary}", {
              source: nodeById.get(edge.from)?.label ?? "",
              target: nodeById.get(edge.to)?.label ?? "",
              summary: linkSummary(edge, gt, m),
            })}
            style={{ left: badge.x, top: badge.y }}
            className={cn(
              "absolute flex h-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center rounded-full border border-border bg-card px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:border-primary aria-pressed:text-primary",
              healthTone(edge.health),
              fade(lit !== null && !lit.edges.has(edge.id)),
            )}
            onClick={() => onSelect(isSelected("edge", edge.id) ? null : target)}
            onFocus={() => setHover(target)}
            onBlur={() => setHover(null)}
            {...hoverProps(target)}
          >
            <AccessMeter access={edge.link.access} />
          </button>
        );
      })}
      {graph.nodes.map((node) => {
        const rect = layout.nodes.get(node.id);
        if (rect === undefined) return null;
        if (node.kind === "client") {
          const ClientIcon = isElectron ? AppWindowIcon : GlobeIcon;
          return (
            <button
              key={node.id}
              {...nodeProps(node, rect, node.label)}
              className={cn(
                nodeClass(node.id),
                "gap-2 rounded-full bg-foreground px-4 text-background forced-colors:border",
              )}
            >
              <ClientIcon aria-hidden className="size-4 shrink-0 opacity-80" />
              <span className="truncate text-sm font-medium">{node.label}</span>
            </button>
          );
        }
        const incoming = links.filter((edge) => edge.to === node.id);
        if (node.kind === "target") {
          const first = incoming[0];
          return (
            <button
              key={node.id}
              {...nodeProps(
                node,
                rect,
                [
                  node.label,
                  gt("known only through a link"),
                  ...incoming.map((edge) =>
                    gt("from {source}: {summary}", {
                      source: nodeById.get(edge.from)?.label ?? "",
                      summary: linkSummary(edge, gt, m),
                    }),
                  ),
                ].join(", "),
              )}
              className={cn(
                nodeClass(node.id),
                "gap-1.5 rounded-md border border-dashed border-foreground/30 bg-background px-2 text-foreground hover:border-foreground/60",
              )}
            >
              {first ? (
                <AccessMeter access={first.link.access} className="text-foreground/80" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-2xs leading-none font-medium">
                {node.label}
              </span>
              {first ? <HealthGlyph health={first.health} /> : null}
            </button>
          );
        }
        const status = environmentStatusText(
          node,
          environmentById.get(node.id),
          links.filter((edge) => edge.from === node.id).length,
          gt,
          m,
        );
        const uncertain = node.phase !== "connected" || node.outgoing !== "loaded";
        return (
          <button
            key={node.id}
            {...nodeProps(node, rect, `${node.label}, ${status}`)}
            className={cn(
              nodeClass(node.id),
              "gap-2.5 rounded-xl border border-border bg-card px-2.5 text-card-foreground shadow-xs/5 hover:border-foreground/40",
            )}
          >
            <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80 forced-colors:border">
              <EnvironmentMachineIcon kind={node.machine ?? "server"} className="size-4" />
              <span
                aria-hidden
                className={cn(
                  "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card",
                  connectionPhaseDotClassName(node.phase),
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm leading-4 font-medium">{node.label}</span>
              <span
                className={cn(
                  "block truncate text-2xs leading-4",
                  node.outgoing === "error" ? "text-destructive" : "text-muted-foreground",
                  uncertain && node.outgoing !== "error" && "italic",
                )}
              >
                {status}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
});

function FleetInspector({
  graph,
  hosts,
  environments,
  selection,
  onSelect,
}: Omit<FleetSceneProps, "layout"> & { readonly hosts: ReadonlyArray<EnvironmentHost> }) {
  const links = graph.edges.filter(isLinkEdge);
  const node =
    selection?.kind === "node" ? graph.nodes.find((entry) => entry.id === selection.id) : undefined;
  const edge =
    selection?.kind === "edge" ? links.find((entry) => entry.id === selection.id) : undefined;
  const labelOf = (id: string) => graph.nodes.find((entry) => entry.id === id)?.label ?? "";
  return (
    <div className="min-h-36 px-3 py-3 text-xs sm:px-4">
      {edge ? (
        <LinkDetails
          key={edge.id}
          edge={edge}
          sourceLabel={labelOf(edge.from)}
          targetLabel={labelOf(edge.to)}
          onSelect={onSelect}
        />
      ) : node ? (
        <NodeDetails
          node={node}
          graph={graph}
          links={links}
          environments={environments}
          canHostLinks={hosts.some(
            (host) => fleetEnvironmentNodeId(host.environmentId) === node.id,
          )}
          onSelect={onSelect}
        />
      ) : links.length === 0 &&
        !graph.nodes.some((n) => n.kind === "environment" && n.outgoing === "loading") ? (
        <NoLinksYet hosts={hosts} />
      ) : (
        <FleetLegend graph={graph} links={links} />
      )}
    </div>
  );
}

function InspectorHeading({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-sm font-medium text-foreground">{children}</h3>
      {detail ? <span className="text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function NoLinksYet({ hosts }: { readonly hosts: ReadonlyArray<EnvironmentHost> }) {
  const gt = useGT();
  return (
    <div className="max-w-xl">
      <InspectorHeading>{gt("No links yet")}</InspectorHeading>
      <p className="text-muted-foreground">
        {gt(
          "A link lets agents on one machine launch and drive threads on another, such as a VPS, with the access you choose. Links run one way and appear here as arrows.",
        )}
      </p>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {hosts.map((host) => (
          <LinkFromHere key={host.environmentId} environmentId={host.environmentId}>
            {gt("From {label}", { label: host.label })}
          </LinkFromHere>
        ))}
      </ul>
    </div>
  );
}

function LinkFromHere({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  if (!canLink) return null;
  return (
    <li className="flex items-center gap-2 text-foreground">
      {children}
      <LinkEnvironmentAction environmentId={environmentId} />
    </li>
  );
}

function LineSample({
  className,
  dash,
  width = 1.75,
}: {
  className: string;
  dash?: string;
  width?: number;
}) {
  return (
    <svg aria-hidden viewBox="0 0 28 8" className={cn("h-2 w-7 shrink-0", className)}>
      <path
        d="M1 4H27"
        stroke="currentColor"
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  );
}

function FleetLegend({
  graph,
  links,
}: {
  readonly graph: FleetGraph;
  readonly links: ReadonlyArray<FleetLinkEdge>;
}) {
  const gt = useGT();
  const m = useMessages();
  const attention = links.filter((edge) => linkNeedsAttention(edge.health)).length;
  const row = "flex items-center gap-2 text-muted-foreground";
  return (
    <div>
      <InspectorHeading
        detail={
          attention === 0
            ? gt("Select a machine or a link for details.")
            : gt("{count, plural, one {# link needs attention.} other {# links need attention.}}", {
                count: attention,
              })
        }
      >
        {gt(
          "{machines, plural, one {# machine} other {# machines}}, {links, plural, =0 {no links} one {# link} other {# links}}",
          { machines: graph.nodes.length - 1, links: links.length },
        )}
      </InspectorHeading>
      <div className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
        <ul className="space-y-1.5" aria-label={gt("Access a link grants")}>
          {ACCESS_LEVELS.map((access) => (
            <li key={access} className={row}>
              <AccessMeter access={access} className="text-foreground/80" />
              {m(accessConfig[access].label)}
            </li>
          ))}
        </ul>
        <ul className="space-y-1.5" aria-label={gt("How a link is doing")}>
          <li className={row}>
            <LineSample className="text-foreground/70" />
            {gt("Reachable")}
          </li>
          <li className={row}>
            <LineSample className="text-warning" />
            {gt("Expires within days")}
          </li>
          <li className={row}>
            <LineSample className="text-muted-foreground" dash="5 4" />
            {gt("Not answering")}
          </li>
          <li className={row}>
            <LineSample className="text-destructive" dash="1 5" />
            {gt("Expired", { $context: "status of a link between two machines" })}
          </li>
          <li className={row}>
            <LineSample className="text-muted-foreground/70" width={1} />
            {gt("Connected to this app")}
          </li>
        </ul>
        <ul className="space-y-1.5" aria-label={gt("Kinds of machine")}>
          <li className={row}>
            <span
              aria-hidden
              className="h-3 w-6 shrink-0 rounded-sm border border-border bg-card"
            />
            {gt("Environment this app knows")}
          </li>
          <li className={row}>
            <span
              aria-hidden
              className="h-3 w-6 shrink-0 rounded-sm border border-dashed border-foreground/40"
            />
            {gt("Known only through a link")}
          </li>
          <li className="text-muted-foreground">
            {gt(
              "A link reaches one machine and stops there. It does not pass on to the machines that one links to.",
            )}
          </li>
        </ul>
      </div>
    </div>
  );
}

function LinkButton({
  edge,
  label,
  onSelect,
}: {
  readonly edge: FleetLinkEdge;
  readonly label: string;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <li>
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => onSelect({ kind: "edge", id: edge.id })}
      >
        <AccessMeter access={edge.link.access} className="text-foreground/80" />
        <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
        <span className="sr-only">{m(accessConfig[edge.link.access].label)}</span>
        <span
          className={cn(
            "shrink-0",
            linkNeedsAttention(edge.health) ? healthTone(edge.health) : "text-muted-foreground",
          )}
        >
          {healthLabel(edge.health, gt)}
        </span>
      </button>
    </li>
  );
}

function NodeDetails({
  node,
  graph,
  links,
  environments,
  canHostLinks,
  onSelect,
}: {
  readonly node: FleetNode;
  readonly graph: FleetGraph;
  readonly links: ReadonlyArray<FleetLinkEdge>;
  readonly environments: ReadonlyArray<EnvironmentHost>;
  readonly canHostLinks: boolean;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const labelOf = (id: string) => graph.nodes.find((entry) => entry.id === id)?.label ?? "";
  if (node.kind === "client") {
    const connections = graph.edges.filter(
      (edge): edge is Extract<FleetEdge, { kind: "connection" }> => edge.kind === "connection",
    );
    return (
      <div>
        <InspectorHeading
          detail={gt("Connected to {connected} of {total} environments", {
            connected: connections.filter((edge) => edge.connected).length,
            total: connections.length,
          })}
        >
          {node.label}
        </InspectorHeading>
        <p className="max-w-xl text-muted-foreground">
          {gt(
            "The map shows the links of the environments this app is connected to. An environment it cannot reach may hold links that are not drawn.",
          )}
        </p>
      </div>
    );
  }
  const out = links.filter((edge) => edge.from === node.id);
  const incoming = links.filter((edge) => edge.to === node.id);
  const environment =
    node.kind === "environment"
      ? environments.find((entry) => entry.environmentId === node.environmentId)
      : undefined;
  const note =
    node.kind === "target"
      ? gt(
          "This app is not connected to {label}, so any links it holds to other machines are not shown.",
          { label: node.label },
        )
      : node.phase !== "connected"
        ? gt(
            "This app is not connected to {label} right now, so any links it holds to other machines are not shown.",
            { label: node.label },
          )
        : node.outgoing === "off"
          ? gt(
              "Linked environments is off on {label}. Turn it on in its Settings, under Labs, to link from it.",
              { label: node.label },
            )
          : node.outgoing === "unknown"
            ? gt("This app may not read the links {label} holds.", { label: node.label })
            : node.outgoing === "error"
              ? gt("Could not load the links {label} holds: {error}", {
                  label: node.label,
                  error: node.outgoingError ?? "",
                })
              : node.outgoing === "loading"
                ? gt("Loading linked environments…")
                : null;
  return (
    <div>
      <InspectorHeading
        detail={
          node.kind === "target"
            ? gt("Known only through a link")
            : [
                node.machine ? m(ENVIRONMENT_MACHINE_KIND_LABELS[node.machine]) : null,
                environment ? connectionStatusTitle(environment.connection, m) : null,
              ]
                .filter((part) => part !== null)
                .join(", ")
        }
      >
        {node.label}
      </InspectorHeading>
      {note ? <p className="mb-2 max-w-xl text-muted-foreground">{note}</p> : null}
      <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {node.kind === "environment" && node.outgoing === "loaded" ? (
          <section>
            <div className="mb-1 flex min-h-6 items-center justify-between gap-2">
              <h4 className="font-medium text-foreground">
                {gt(
                  "{count, plural, =0 {Links to no one} one {Links to # machine} other {Links to # machines}}",
                  {
                    count: out.length,
                  },
                )}
              </h4>
              {canHostLinks ? (
                <ul>
                  <LinkFromHere environmentId={node.environmentId}>{null}</LinkFromHere>
                </ul>
              ) : null}
            </div>
            <ul className="-mx-1.5 max-h-48 overflow-y-auto">
              {out.map((edge) => (
                <LinkButton
                  key={edge.id}
                  edge={edge}
                  label={labelOf(edge.to)}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </section>
        ) : null}
        <section>
          <h4 className="mb-1 flex min-h-6 items-center font-medium text-foreground">
            {gt(
              "{count, plural, =0 {No known machine links here} one {Linked from # machine} other {Linked from # machines}}",
              { count: incoming.length },
            )}
          </h4>
          <ul className="-mx-1.5 max-h-48 overflow-y-auto">
            {incoming.map((edge) => (
              <LinkButton
                key={edge.id}
                edge={edge}
                label={labelOf(edge.from)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function LinkDetails({
  edge,
  sourceLabel,
  targetLabel,
  onSelect,
}: {
  readonly edge: FleetLinkEdge;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { link, health } = edge;
  const canUnlink = useAtomValue(
    peerLinkEnvironment.unlink.permissionAtom(edge.sourceEnvironmentId),
  );
  const { busy, forget } = useForgetPeerLink(edge.sourceEnvironmentId, link);
  const access = accessConfig[link.access];
  const when = (value: DateTime.Utc) => formatAccessTimestamp(DateTime.formatIso(value));
  const term = "text-muted-foreground";
  const endpoint =
    "cursor-pointer rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <button
            type="button"
            className={endpoint}
            onClick={() => onSelect({ kind: "node", id: edge.from })}
          >
            {sourceLabel}
          </button>
          <span className="text-muted-foreground">
            {gt("links to", { $context: "between two machine names: A links to B" })}
          </span>
          <button
            type="button"
            className={endpoint}
            onClick={() => onSelect({ kind: "node", id: edge.to })}
          >
            {targetLabel}
          </button>
        </h3>
        {canUnlink ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void forget()}
          >
            {busy ? gt("Forgetting…") : gt("Forget")}
          </Button>
        ) : null}
      </div>
      <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className={term}>{gt("Access", { $context: "access level" })}</dt>
        <dd>
          <span className="flex items-center gap-2 text-foreground">
            <AccessMeter access={link.access} className="text-foreground/80" />
            {m(access.label)}
          </span>
          <span className="text-muted-foreground">{m(access.description)}</span>
        </dd>
        <dt className={term}>
          {gt("Status", { $context: "state of a link between two machines" })}
        </dt>
        <dd
          className={cn(
            "flex items-center gap-1.5",
            linkNeedsAttention(health) ? healthTone(health) : "text-foreground",
          )}
        >
          <HealthGlyph health={health} />
          {peerLinkStatusText(health, gt)}
        </dd>
        <dt className={term}>
          {gt("Expires", { $context: "label before the date a link expires" })}
        </dt>
        <dd className="text-foreground">{when(link.expiresAt)}</dd>
        <dt className={term}>
          {gt("Linked", { $context: "label before the date a link was made" })}
        </dt>
        <dd className="text-foreground">{when(link.linkedAt)}</dd>
        {link.lastReachedAt ? (
          <>
            <dt className={term}>{gt("Last reached")}</dt>
            <dd className="text-foreground">{when(link.lastReachedAt)}</dd>
          </>
        ) : null}
        <dt className={term}>{gt("Addresses")}</dt>
        <dd className="min-w-0 font-mono text-2xs break-all text-foreground">
          {link.urls.map((url) => (
            <span key={url} className="block">
              {url}
            </span>
          ))}
        </dd>
      </dl>
    </div>
  );
}
