import type { RangerNeedsYou } from "../../desk/sources/ranger";

export const GITLAB_BODY = "## Deliverable\nChoose CSV or JSON for the export in group/subgroup/app.\n";

export const GITLAB_BLOCKED: RangerNeedsYou = {
  key: "gitlab:gitlab.example.org/group/subgroup/app#12",
  repo: "gitlab:gitlab.example.org/group/subgroup/app",
  nodeId: "12",
  title: "Pick the export format",
  status: "parked",
  url: "https://gitlab.example.org/group/subgroup/app/-/issues/12",
  endedAt: "2026-10-31T08:00:00.000Z",
  reason: { class: "blocked", detail: "resume once: the principal picks CSV or JSON, — Blocked: the spec names both formats." },
  actions: { resume: true },
};

export const GITLAB_EXPLAINED = {
  sentence: "The agent needs you to choose CSV or JSON for the export in node #12 before it can continue.",
  choices: [
    { label: "Use CSV", consequence: "The agent exports CSV and the node resumes.", ruling: "Use CSV for the export in group/subgroup/app; resume node #12." },
    { label: "Use JSON", consequence: "The agent exports JSON and the node resumes.", ruling: "Use JSON for the export in group/subgroup/app; resume node #12." },
  ],
};
