import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VigilView } from "../components/vigil-view";
import type { VigilSubjectView } from "../../api/vigil";

const subject: VigilSubjectView = {
  subjectKey: "state:goal:G1", kind: "state", vocab: "goal", ref: "G1",
  goalId: "G1", goalWording: "Example goal", value: "on-track", healthy: true,
  lastRunId: "run-123", lastEndedAt: Date.parse("2026-10-12T10:00:00.000Z"),
  expectedBy: Date.parse("2026-10-13T12:00:00.000Z"),
};

describe("VigilView", () => {
  it("renders one row per subject, all fields, vocabulary and expected by", () => {
    const html = renderToStaticMarkup(<VigilView loaded subjects={[subject, {
      ...subject, subjectKey: "state:escalation:example/project#604", vocab: "escalation",
      ref: "example/project#604", goalId: null, goalWording: null,
      value: "overdue", healthy: false, expectedBy: null,
    }]} />);
    expect((html.match(/<tr>/g) ?? []).length).toBe(3);
    for (const label of ["Subject", "Kind", "Vocabulary", "Reference", "Goal", "State", "Healthy", "Last run", "Last ended", "Expected by"]) {
      expect(html).toContain(`scope="col">${label}</th>`);
    }
    for (const value of ["state:goal:G1", ">state<", ">goal<", "Example goal", "on-track", ">Yes<", "run-123", "state:escalation:example/project#604", ">escalation<", "overdue", ">No<"]) {
      expect(html).toContain(value);
    }
    expect(html).toContain('dateTime="2026-10-12T10:00:00.000Z"');
    expect(html).toContain('dateTime="2026-10-13T12:00:00.000Z"');
    expect(html).toContain("<td></td></tr>");
  });

  it("falls back to goal ID when wording is unavailable and leaves run vocabulary blank", () => {
    const html = renderToStaticMarkup(<VigilView loaded subjects={[{
      ...subject, subjectKey: "run:flow:daily-sweep", kind: "run", vocab: null,
      goalWording: null, expectedBy: null,
    }]} />);
    expect(html).toContain("<td>G1</td>");
    expect(html).toContain("<td>run</td><td></td>");
    expect(html).not.toContain("Example goal");
  });

  it("escapes resolved goal wording", () => {
    const html = renderToStaticMarkup(<VigilView loaded subjects={[{
      ...subject, goalWording: '<script>alert("goal")</script>',
    }]} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows empty, loading, disabled and error states truthfully", () => {
    expect(renderToStaticMarkup(<VigilView loaded subjects={[]} />)).toContain("No subjects watched yet.");
    expect(renderToStaticMarkup(<VigilView loaded={false} subjects={[]} />)).toContain("Loading…");
    expect(renderToStaticMarkup(<VigilView loaded enabled={false} subjects={[]} />)).toContain("Vigil is not enabled on this stack.");
    const error = renderToStaticMarkup(<VigilView loaded subjects={[]} error="Could not load watched subjects." />);
    expect(error).toContain('role="alert"');
    expect(error).not.toContain("No subjects watched yet.");
  });
});
