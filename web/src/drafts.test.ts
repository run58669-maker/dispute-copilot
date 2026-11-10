import { describe, expect, it } from "vitest";
import { draftForAction } from "./drafts.js";

const base = { recommended: "ACCEPT" as const, aiDraft: "AI accept text", aiLabel: "AI · m", templates: { OFFER: "offer template", ACCEPT: "accept template" } };

describe("draftForAction", () => {
  it("unedited text switches to the chosen action's template and says so", () => {
    expect(draftForAction({ ...base, chosen: "OFFER", edited: false })).toEqual({ text: "offer template", label: "template for OFFER; edit freely", notice: "" });
  });
  it("switching back to the recommended action restores the AI draft and label", () => {
    expect(draftForAction({ ...base, chosen: "ACCEPT", edited: false })).toEqual({ text: "AI accept text", label: "AI · m; edit freely", notice: "" });
  });
  it("edited text is kept and flagged when the action differs from the recommended one", () => {
    const v = draftForAction({ ...base, chosen: "OFFER", edited: true });
    expect(v.text).toBeNull();
    expect(v.notice).toMatch(/written for ACCEPT/);
  });
  it("edited text on the recommended action has no notice", () => {
    expect(draftForAction({ ...base, chosen: "ACCEPT", edited: true }).notice).toBe("");
  });
  it("without a template for the chosen action the text is left as it was", () => {
    expect(draftForAction({ ...base, templates: {}, chosen: "OFFER", edited: false }).text).toBe("AI accept text");
  });
});
