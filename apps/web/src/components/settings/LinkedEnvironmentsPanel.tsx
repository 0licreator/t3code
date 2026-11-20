import { useGT } from "gt-react";
import { useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import type { EnvironmentPresentation } from "~/state/environments";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { LinkedEnvironmentsMap } from "./LinkedEnvironmentsMap";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";
import { SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type LinkedEnvironmentsView = "list" | "map";

/**
 * The linked environments of every host, as the list or as the map. The list is the default and
 * the only view on narrow screens: it is the map's accessible equivalent.
 */
export function LinkedEnvironmentsPanel({
  hosts,
}: {
  readonly hosts: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
  const search = useSearchableSetting()("linked-environments");
  const roomForMap = useMediaQuery("md");
  const [view, setView] = useState<LinkedEnvironmentsView>("list");
  // The toggle moves between section headers with the view, so the pressed side takes focus back.
  const [toggled, setToggled] = useState(false);
  // The toggle unmounts on a narrow screen; when it returns it must not take focus unasked.
  if (!roomForMap && toggled) setToggled(false);
  if (hosts.length === 0) return null;
  const shown = roomForMap ? view : "list";
  const viewToggle = roomForMap ? (
    <ToggleGroup
      aria-label={gt("Show linked environments as")}
      value={[shown]}
      onValueChange={(next) => {
        const value = next[0];
        if (value !== "list" && value !== "map") return;
        setView(value);
        setToggled(true);
      }}
    >
      <Toggle value="list" autoFocus={toggled && shown === "list"}>
        {gt("List", { $context: "view switch: show items as a list" })}
      </Toggle>
      <Toggle value="map" autoFocus={toggled && shown === "map"}>
        {gt("Map", { $context: "view switch: show machines as a diagram" })}
      </Toggle>
    </ToggleGroup>
  ) : null;
  if (shown === "map") {
    return (
      <SettingsSection id={search.id} title={search.title} titleAction={viewToggle}>
        <LinkedEnvironmentsMap hosts={hosts} />
      </SettingsSection>
    );
  }
  return hosts.map((environment, index) => (
    <LinkedEnvironmentsSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={hosts.length > 1 ? environment.label : null}
      isSearchTarget={index === 0}
      titleAction={index === 0 ? viewToggle : null}
    />
  ));
}
