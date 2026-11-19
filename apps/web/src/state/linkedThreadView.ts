import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  connectLinkedEnvironment,
  createLinkedThreadSession,
  type LinkedThreadOpen,
  type LinkedThreadTarget,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useState, useSyncExternalStore } from "react";

import { connectPairing, reachesEnvironment } from "../connection/onboarding";
import { getDocumentActivity } from "../lib/documentActivity";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useAtomCommand } from "./use-atom-command";

/** The linked environment's thread the read-only view shows, or none. */
export const linkedThreadViewAtom = Atom.make<LinkedThreadTarget | null>(null).pipe(
  Atom.withLabel("linked-thread-view"),
);

/** Opens a linked environment's thread in the read-only view. */
export function useOpenLinkedThread(): (target: LinkedThreadTarget) => void {
  return useAtomSet(linkedThreadViewAtom);
}

/**
 * How a click opens a thread that a thread in `viaEnvironmentId` says is on a linked environment:
 * in place when this client is connected there itself, else read-only through the link. Once the
 * link is gone a saved environment opens in place, where the client can reconnect to it; with
 * neither, the read-only view says what to link again.
 */
export function useLinkedThreadOpener(
  viaEnvironmentId: EnvironmentId,
  thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly label: string;
      }
    | undefined,
  title: string | null,
): { readonly mode: Exclude<LinkedThreadOpen, "unavailable">; readonly open: () => void } | null {
  const navigate = useNavigate();
  const openLinked = useOpenLinkedThread();
  const own = useEnvironment(thread?.environmentId ?? null);
  const connected = own?.connection.phase === "connected";
  const links = useLinkedEnvironments(thread === undefined || connected ? null : viaEnvironmentId);
  if (thread === undefined) return null;
  const resolved = resolveLinkedThreadOpen({
    environmentId: thread.environmentId,
    viaEnvironmentId,
    own: own === null ? undefined : { connected },
    linked: links.has(thread.environmentId),
  });
  const mode = resolved === "direct" ? "direct" : "linked";
  return {
    mode,
    open: () => {
      if (mode === "linked") {
        openLinked({ viaEnvironmentId, ...thread, label: own?.label ?? thread.label, title });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
      });
    },
  };
}

/** A linked environment the add-environment dialog opens for, with what is known about it filled in. */
export interface AddEnvironmentPrefill {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly host: string | null;
}

export const addEnvironmentPrefillAtom = Atom.make<AddEnvironmentPrefill | null>(null).pipe(
  Atom.withLabel("add-environment-prefill"),
);

export type LinkedEnvironmentConnectState =
  | { readonly phase: "idle" | "connecting" }
  | { readonly phase: "unreachable"; readonly label: string };

/**
 * Connects this client to the environment `target` lives in and opens the thread there. One step
 * when the linking environment can get a pairing for this client; otherwise the add-environment
 * dialog opens for that machine.
 */
export function useConnectLinkedEnvironment(target: LinkedThreadTarget) {
  const navigate = useNavigate();
  const closeView = useAtomSet(linkedThreadViewAtom);
  const setPrefill = useAtomSet(addEnvironmentPrefillAtom);
  const mayPair = useAtomValue(
    peerLinkEnvironment.pairClient.permissionAtom(target.viaEnvironmentId),
  );
  const quiet = { reportFailure: false, reportDefect: false } as const;
  const requestPairing = useAtomCommand(peerLinkEnvironment.pairClient, quiet);
  const reaches = useAtomCommand(reachesEnvironment, quiet);
  const pair = useAtomCommand(connectPairing, quiet);
  const [state, setState] = useState<LinkedEnvironmentConnectState>({ phase: "idle" });
  const connect = async () => {
    setState({ phase: "connecting" });
    const outcome = await connectLinkedEnvironment({
      label: target.label,
      requestPairing: async () => {
        // Without it the linking environment refuses; the user can still pair by hand.
        if (!mayPair) return null;
        const result = await requestPairing({
          environmentId: target.viaEnvironmentId,
          input: { environmentId: target.environmentId },
        });
        return result._tag === "Success" ? result.value : null;
      },
      reaches: async (host) => {
        const result = await reaches({ host, environmentId: target.environmentId });
        return result._tag === "Success" && result.value;
      },
      pair: async ({ host, pairingCode }) => {
        const result = await pair({
          host,
          pairingCode,
          expectedEnvironmentId: target.environmentId,
        });
        return result._tag === "Success";
      },
    });
    if (outcome.type === "unreachable") {
      setState({ phase: "unreachable", label: outcome.label });
      return outcome;
    }
    closeView(null);
    if (outcome.type === "connected") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
      });
      return outcome;
    }
    setPrefill({ environmentId: target.environmentId, label: outcome.label, host: outcome.host });
    void navigate({ to: "/settings/connections" });
    return outcome;
  };
  return { state, connect };
}

/**
 * The transcript of `target`, read through the environment that links to it. Reads start when the
 * calling view mounts and stop when it unmounts; key the view by its target.
 */
export function useLinkedThreadSession(target: LinkedThreadTarget) {
  const read = useAtomCommand(peerLinkEnvironment.readThread, {
    reportFailure: false,
    reportDefect: false,
  });
  const [session] = useState(() =>
    createLinkedThreadSession({
      read: async (cursor) => {
        const result = await read({
          environmentId: target.viaEnvironmentId,
          input: { environmentId: target.environmentId, threadId: target.threadId, ...cursor },
        });
        return result._tag === "Success"
          ? { ok: true, page: result.value }
          : { ok: false, error: squashAtomCommandFailure(result) };
      },
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      isActive: () => getDocumentActivity().visible,
    }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { state, session };
}
