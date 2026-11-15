import type { Rule } from "eslint";
import type { CallExpression, Expression, Node, Super } from "estree";

const ASYNC_MODIFIERS = new Set(["rejects", "resolves"]);

function propertyName(node: Expression | Super): string | undefined {
  if (node.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier") return undefined;
  return node.property.name;
}

function asyncModifier(call: CallExpression): string | undefined {
  let node: Expression | Super = call.callee;
  let modifier: string | undefined;
  while (node.type === "MemberExpression") {
    const name = propertyName(node);
    if (name !== undefined && ASYNC_MODIFIERS.has(name)) modifier = name;
    node = node.object;
  }
  const fromExpect = node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect";
  return fromExpect ? modifier : undefined;
}

const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);

const combinesPromises = (call: CallExpression): boolean =>
  call.callee.type === "MemberExpression" && call.callee.object.type === "Identifier" && call.callee.object.name === "Promise" && PROMISE_COMBINATORS.has(propertyName(call.callee) ?? "");

function isAwaited(node: Node & Rule.NodeParentExtension): boolean {
  const { parent } = node;
  switch (parent.type) {
    case "AwaitExpression":
    case "ReturnStatement":
      return true;
    case "ArrowFunctionExpression":
      return parent.body === node;
    case "ChainExpression":
    case "ArrayExpression":
      return isAwaited(parent);
    case "CallExpression":
      return parent.callee !== node && combinesPromises(parent) && isAwaited(parent);
    default:
      return false;
  }
}

export const awaitAsyncExpect: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "An `expect(...).rejects` or `.resolves` assertion is awaited, or it cannot fail the test" },
    messages: {
      unawaited:
        "Un-awaited `.{{modifier}}` assertion: the test ends before it settles, so it cannot fail. Write `await expect(...).{{modifier}}...`.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const modifier = asyncModifier(node);
        if (modifier === undefined || isAwaited(node)) return;
        context.report({ node, messageId: "unawaited", data: { modifier } });
      },
    };
  },
};
