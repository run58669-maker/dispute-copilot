export type DraftAction = "FIGHT" | "OFFER" | "ACCEPT";

export interface DraftView {
  /** New textarea content, or null to leave the seller's text alone. */
  text: string | null;
  /** Suffix label shown after "Draft", e.g. "template for OFFER; edit freely". */
  label: string;
  /** One-line notice when hand-edited text was written for another action. */
  notice: string;
}

/**
 * What the draft box shows after the Action menu changes.
 * Unedited text follows the action: AI draft for the recommended one, the action's template otherwise.
 * Edited text is kept, with a notice when the chosen action is not the one it was written for.
 */
export function draftForAction(opts: {
  chosen: DraftAction;
  recommended: DraftAction;
  aiDraft: string;
  aiLabel: string;
  templates: Partial<Record<DraftAction, string>>;
  edited: boolean;
}): DraftView {
  const { chosen, recommended, aiDraft, aiLabel, templates, edited } = opts;
  const template = templates[chosen];
  if (chosen === recommended || template === undefined) {
    return { text: edited ? null : aiDraft, label: `${aiLabel}; edit freely`, notice: edited && chosen !== recommended ? noticeFor(recommended) : "" };
  }
  if (edited) return { text: null, label: `${aiLabel}; edit freely`, notice: noticeFor(recommended) };
  return { text: template, label: `template for ${chosen}; edit freely`, notice: "" };
}

const noticeFor = (written: DraftAction) => `This text was written for ${written}, not the action selected.`;
