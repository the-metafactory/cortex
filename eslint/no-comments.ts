import type { AST, Rule, SourceCode } from "eslint";

const TS_SUPPRESSION = /^\s*@ts-(ignore|expect-error|nocheck)\b/;
const LICENSE = /licen[cs]e|copyright|SPDX-License-Identifier/i;
const URL = /https?:\/\//;

type Comment = AST.Program["comments"][number];

const EXPORTS = new Set(["ExportNamedDeclaration", "ExportDefaultDeclaration"]);

function documentsExport(source: SourceCode, comment: Comment): boolean {
  const token = source.getTokenAfter(comment);
  if (!token) return false;
  let node = source.getNodeByRangeIndex(token.range[0]);
  while (node) {
    if (EXPORTS.has(node.type)) return true;
    const parent: Rule.Node | null = (node as Rule.Node).parent;
    if (parent?.range?.[0] !== token.range[0]) return false;
    node = parent;
  }
  return false;
}

function isAllowed(source: SourceCode, comment: Comment, first: boolean): boolean {
  const { type, value } = comment;
  if (first && LICENSE.test(value)) return true;
  if (type === "Line" && /^\/\s*<reference\b/.test(value)) return true;
  if (/^\s*prettier-ignore\b/.test(value)) return true;
  if (URL.test(value)) return true;
  return type === "Block" && value.startsWith("*") && documentsExport(source, comment);
}

export const noComments: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Say it in code, not in a comment" },
    messages: {
      suppression:
        "Type-check suppression. Fix the type error instead. A test that needs a wrong-typed value casts through `unknown`.",
      comment:
        "Comment. Say it in code: rename, extract, add a type or a test. Kept: a URL to the issue or vendor doc behind a constraint, a /** doc */ on an export, a license header.",
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    return {
      Program() {
        const comments = source.getAllComments().filter((c) => (c.type as string) !== "Shebang");
        comments.forEach((comment, i) => {
          if (!comment.loc) return;
          if (TS_SUPPRESSION.test(comment.value)) context.report({ loc: comment.loc, messageId: "suppression" });
          else if (!isAllowed(source, comment, i === 0)) context.report({ loc: comment.loc, messageId: "comment" });
        });
      },
    };
  },
};

export const cortex = { rules: { "no-comments": noComments } };
