/** Mobile layout composer controls: bottom sheets in place of the desktop
 * dropdowns, which are too small to hit on a phone. ChatPanel renders these
 * when hosted by MobileShell; the new-session page adds the project chip. */

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Ellipsis, FolderOpen, Lock } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fmtNumber, harnessModelLabel, type Harness, type OptionChoice, type Project } from "../api";
import { ltr } from "../i18n";
import { m } from "../paraglide/messages.js";
import { getHarnessesQuery } from "../queries/settings";
import { HarnessLogo } from "./HarnessLogo";
import { modelGroup, pickedSelection, selectionLabel, type ModelSelection } from "./ModelPicker";
import { IconButton, Switch } from "./ui";
import { useDialogFocus } from "./useDialogFocus";

const CHIP_CLASS = "flex h-8 min-w-0 items-center gap-1 rounded-full bg-surface px-2.5 text-xs text-text";
const ROW_CLASS = "flex w-full items-center gap-2 px-4 py-3 text-start text-sm active:bg-surface";
const EMPTY_HARNESSES: Harness[] = [];

/** A panel sliding up from the bottom edge over a backdrop; tapping the
 * backdrop or pressing Escape closes it. */
export function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" tabIndex={-1} aria-label={m.mobile_close()} className="min-h-12 flex-1 bg-modal-backdrop" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className="flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-border bg-panel pb-[max(1rem,env(safe-area-inset-bottom))] text-text">
        <div className="mx-auto my-2 h-1 w-10 shrink-0 rounded-full bg-border" />
        <div className="shrink-0 px-4 pb-2 text-sm font-medium">{title}</div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function SheetHeading({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-xs font-medium text-muted">{children}</div>;
}

/** Harness and model chip; picks from a bottom sheet grouped by harness. An
 * open session keeps its harness, so only that one is offered. */
export function MobileModelChip({ value, onSelect, lockHarness = false, openRequest = 0 }: {
  value: ModelSelection | null;
  onSelect: (value: ModelSelection) => void;
  lockHarness?: boolean;
  /** Increments to open the sheet (the `/model` command). */
  openRequest?: number;
}) {
  const { data: harnesses = EMPTY_HARNESSES } = useQuery(getHarnessesQuery());
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const handledOpenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest;
    setOpen(true);
  }, [openRequest]);
  const close = () => {
    setOpen(false);
    setFilter("");
  };
  const query = filter.trim();
  const shown = lockHarness && value ? harnesses.filter((h) => h.id === value.harness) : harnesses;
  const pick = (harness: Harness, model: string | null) => {
    onSelect(pickedSelection(harness, model, value));
    close();
  };
  const label = selectionLabel(harnesses, value);
  return (
    <>
      <button type="button" className={CHIP_CLASS} title={m.a11y_chat_model({ label })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {value?.harness && <HarnessLogo harness={value.harness} size={12} />}
        <span className="truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0 text-muted" />
      </button>
      {open && (
        <BottomSheet title={m.model_picker_model()} onClose={close}>
          <div className="px-4 pb-1">
            <input type="search" className="w-full rounded-md border border-border bg-background px-3 py-2 text-base outline-none"
              placeholder={m.model_picker_search_or_enter_id()} value={filter} onChange={(event) => setFilter(event.target.value)} />
          </div>
          {shown.map((harness) => {
            const group = modelGroup(harness, query.toLowerCase());
            const row = (model: string | null, text: string) => (
              <button type="button" key={model ?? ""} className={ROW_CLASS} title={model ?? undefined} onClick={() => pick(harness, model)}>
                <span className="min-w-0 flex-1 truncate">{text}</span>
                {value?.harness === harness.id && value.model === model && <Check size={16} className="shrink-0 text-primary" />}
              </button>
            );
            return (
              <div key={harness.id} className="border-b border-border last:border-b-0">
                <SheetHeading>
                  <HarnessLogo harness={harness.id} size={12} />
                  <span className="flex-1">{harness.name}</span>
                  {!harness.agentReady && (harness.catalogPending ? m.onboarding_checking() : <><Lock size={10} />{m.model_picker_unavailable()}</>)}
                </SheetHeading>
                {harness.agentReady && <>
                  {!query && row(null, m.model_picker_default_model())}
                  {group.models.map((model) => row(model.id, harnessModelLabel(model)))}
                  {/* An explicit ID is passed to the CLI without claiming availability. */}
                  {query && !harness.models.some((model) => model.id === query) &&
                    row(query, `${m.model_picker_use_id({ id: ltr(query) })} · ${m.model_picker_unverified()}`)}
                  {group.hidden > 0 && <div className="px-4 pb-2 text-xs text-muted">{m.model_picker_more({ count: fmtNumber(group.hidden) })}</div>}
                </>}
              </div>
            );
          })}
          {harnesses.length === 0 && <div className="px-4 py-3 text-sm text-muted">{m.model_picker_detecting_harnesses()}</div>}
          {lockHarness && value && harnesses.length > 1 && (
            <div className="px-4 py-2 text-xs text-muted">
              <Lock size={10} className="me-1 inline-block" aria-hidden="true" />
              {m.model_picker_sessions_keep_their_harness_new_chat_to_switch()}
            </div>
          )}
        </BottomSheet>
      )}
    </>
  );
}

interface ChoiceGroup {
  title: string;
  choices: OptionChoice[];
  effectiveId: string | undefined;
  defaultId: string | null;
  onSelect: (id: string) => void;
}

/** The composer's "⋯" menu: plan mode, permission mode and effort, which the
 * desktop composer keeps in its own controls. */
export function MobileComposerMenu({ plan, groups }: {
  /** Absent when the harness has no plan mode. */
  plan: { active: boolean; onToggle: () => void } | null;
  groups: ChoiceGroup[];
}) {
  const [open, setOpen] = useState(false);
  const shownGroups = groups.filter((group) => group.choices.length > 0);
  if (!plan && !shownGroups.length) return null;
  return (
    <>
      <IconButton type="button" aria-label={m.mobile_more_options()} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <Ellipsis size={16} />
      </IconButton>
      {open && (
        <BottomSheet title={m.mobile_more_options()} onClose={() => setOpen(false)}>
          {plan && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm">
              <span className="flex-1">{m.mobile_plan_mode()}</span>
              <Switch checked={plan.active} aria-label={m.mobile_plan_mode()} onClick={plan.onToggle} />
            </div>
          )}
          {shownGroups.map((group) => (
            <div key={group.title} className="border-t border-border">
              <SheetHeading>{group.title}</SheetHeading>
              {group.choices.map((choice) => (
                <button type="button" key={choice.id} className={ROW_CLASS} onClick={() => { group.onSelect(choice.id); setOpen(false); }}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span>
                      {choice.label}
                      {choice.id === group.defaultId && <span className="text-muted"> {m.model_picker_default()}</span>}
                    </span>
                    {choice.description && <span className="text-xs text-muted">{choice.description}</span>}
                  </span>
                  {choice.id === group.effectiveId && <Check size={16} className="shrink-0 text-primary" />}
                </button>
              ))}
            </div>
          ))}
        </BottomSheet>
      )}
    </>
  );
}

/** The new-session page's project chip; picks from a bottom sheet. */
export function MobileProjectChip({ projects, projectId, onSelect }: {
  projects: Project[];
  projectId: string;
  onSelect: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = projects.find((project) => project.id === projectId)?.name ?? "";
  return (
    <>
      <button type="button" className={CHIP_CLASS} aria-label={`${m.header_project()}: ${name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <FolderOpen size={12} className="shrink-0" />
        <span className="truncate">{name}</span>
        <ChevronDown size={12} className="shrink-0 text-muted" />
      </button>
      {open && (
        <BottomSheet title={m.header_project()} onClose={() => setOpen(false)}>
          {projects.map((project) => (
            <button type="button" key={project.id} className={ROW_CLASS} onClick={() => { onSelect(project.id); setOpen(false); }}>
              <FolderOpen size={16} className="shrink-0 text-subtext" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.id === projectId && <Check size={16} className="shrink-0 text-primary" />}
            </button>
          ))}
        </BottomSheet>
      )}
    </>
  );
}
