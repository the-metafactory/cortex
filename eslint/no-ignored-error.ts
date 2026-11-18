import type { Rule } from "eslint";
import type { CatchClause, Expression, Node, Pattern, Statement } from "estree";

type Handler = Rule.Node & { params: Pattern[]; body: Expression | Statement };

const NESTED_FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

function namesAFallback(node: Node | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  if (node.type === "Identifier") return node.name !== "undefined";
  return node.type === "MemberExpression";
}

function actsOnFailure(node: Node): boolean {
  if (node.type === "ThrowStatement" || node.type === "CallExpression" || node.type === "NewExpression") return true;
  if (node.type === "ReturnStatement") return namesAFallback(node.argument);
  if (NESTED_FUNCTIONS.has(node.type)) return false;
  return Object.entries(node).some(([key, value]) => key !== "parent" && childNodes(value).some(actsOnFailure));
}

function childNodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.filter(isNode);
  return isNode(value) ? [value] : [];
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

const ignoresError = (param: Pattern | null | undefined): boolean => param === null || param === undefined;

function callbackHandles(handler: Handler): boolean {
  if (handler.body.type === "BlockStatement") return actsOnFailure(handler.body);
  return namesAFallback(handler.body) || actsOnFailure(handler.body);
}

function catchCallback(node: Rule.Node): Handler | undefined {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression" || node.callee.property.type !== "Identifier") return undefined;
  if (node.callee.property.name !== "catch") return undefined;
  const [callback] = node.arguments;
  if (callback === undefined || (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression")) return undefined;
  return callback as unknown as Handler;
}

export const noIgnoredError: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "A caught error is logged, rethrown, or answered with a named fallback; never silently dropped" },
    messages: {
      ignored:
        "This handler drops the error: it neither binds it, rethrows, calls anything, nor returns a named fallback. " +
        "Log it (`process.stderr.write`), rethrow it, or return a constant whose name says why falling back is safe (e.g. `return NOT_INSTALLED`).",
    },
    schema: [],
  },
  create(context) {
    return {
      CatchClause(node: CatchClause & Rule.NodeParentExtension) {
        if (ignoresError(node.param) && !actsOnFailure(node.body)) context.report({ node, messageId: "ignored" });
      },
      CallExpression(node) {
        const handler = catchCallback(node);
        if (handler !== undefined && ignoresError(handler.params[0]) && !callbackHandles(handler)) context.report({ node: handler, messageId: "ignored" });
      },
    };
  },
};
