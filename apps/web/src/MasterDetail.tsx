import { Loading } from "./Scope.tsx";
import type { ReactNode } from "react";
import { t } from "i18next";

export interface PanelItem {
  key: string;
  label: ReactNode;
  /** A second line under the label. */
  hint?: ReactNode;
  badge?: ReactNode;
  muted?: boolean;
}

export interface PanelGroup {
  title?: string;
  items: PanelItem[];
  /** Shown when the group has no items. */
  empty?: string;
}

/**
 * A list in a secondary panel on the left and the chosen item on the right, as in project and user administration.
 * `selected` null is the add form (`add`); undefined shows `placeholder`.
 */
export function MasterDetail(props: {
  title: string;
  groups: PanelGroup[];
  selected: string | null | undefined;
  onSelect: (key: string) => void;
  add?: { label: string; onClick: () => void };
  /** Above the groups, under the title (a filter, a note). */
  top?: ReactNode;
  placeholder?: string;
  /** The list is on its way: a loading veil over it. */
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full">
      <nav className="relative flex w-72 shrink-0 flex-col border-e border-line p-2 text-sm">
        <Loading show={!!props.loading} />
        <h2 className="section-header px-2 py-1">{props.title}</h2>
        {props.top}
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {props.groups.map((g, i) => (
            <div key={g.title ?? i} className={g.title ? "mt-3 first:mt-0" : ""}>
              {g.title && <h3 className="px-2 py-1 text-xs font-medium text-fg-muted">{g.title}</h3>}
              {g.items.map((it) => (
                <button
                  key={it.key}
                  onClick={() => props.onSelect(it.key)}
                  data-active={props.selected === it.key}
                  className="list-row flex w-full items-center gap-2 px-2 py-1.5 text-start"
                >
                  <span className={`min-w-0 flex-1 ${it.muted ? "text-fg-muted" : ""}`}>
                    <span className="block truncate">{it.label}</span>
                    {it.hint && <span className="block truncate text-xs text-fg-muted">{it.hint}</span>}
                  </span>
                  {it.badge && <span className="flex shrink-0 gap-1">{it.badge}</span>}
                </button>
              ))}
              {!g.items.length && g.empty && <p className="px-2 py-1.5 text-fg-muted">{g.empty}</p>}
            </div>
          ))}
          {props.add && (
            <button onClick={props.add.onClick} data-active={props.selected === null} className="list-row mt-1 w-full px-2 py-1.5 text-start text-primary">
              + {props.add.label}
            </button>
          )}
        </div>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {props.children ?? (props.selected === undefined && <p className="detail text-sm text-fg-muted">{props.placeholder ?? t("selectItem")}</p>)}
      </div>
    </div>
  );
}
