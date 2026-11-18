import type { Rule } from "eslint";
import type { CallExpression, Node } from "estree";

interface KeyNode {
  type: string;
  name?: string;
  value?: unknown;
}
interface Member {
  type: string;
  key?: KeyNode;
  computed?: boolean;
}
interface TypeShape {
  node: Node;
  name: string;
  sig: string;
}

const MIN_SHARED_KEYS = 2;
const PARSE_METHODS = new Set(["parse", "parseAsync"]);

interface Named {
  type: string;
  parent?: Named;
  id?: { name: string };
}

function enclosingTypeName(node: Named): string {
  const owner = node.parent;
  if (owner === undefined) return "This type";
  if (owner.type === "TSTypeAliasDeclaration" && owner.id) return owner.id.name;
  return owner.type.startsWith("TS") ? enclosingTypeName(owner) : "This type";
}

function parsedSchema(node: Node): string | undefined {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return undefined;
  const { object, property } = node.callee;
  if (property.type !== "Identifier" || !PARSE_METHODS.has(property.name) || object.type !== "Identifier") return undefined;
  return object.name.endsWith("Schema") ? object.name : undefined;
}

function keyName(key: KeyNode | undefined, computed: boolean | undefined): string | undefined {
  if (key === undefined || computed === true) return undefined;
  if (key.type === "Identifier") return key.name;
  return typeof key.value === "string" ? key.value : undefined;
}

function signature(keys: (string | undefined)[]): string | undefined {
  if (keys.some((k) => k === undefined) || keys.length < MIN_SHARED_KEYS) return undefined;
  return [...(keys as string[])].sort().join(",");
}

function zodObjectKeys(call: CallExpression): (string | undefined)[] | undefined {
  const { callee } = call;
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier" || callee.object.name !== "z") return undefined;
  if (callee.property.type !== "Identifier" || callee.property.name !== "object") return undefined;
  const [shape] = call.arguments;
  if (shape?.type !== "ObjectExpression") return undefined;
  return shape.properties.map((p) => (p.type === "Property" ? keyName(p.key as KeyNode, p.computed) : undefined));
}

function memberKeys(members: Member[]): (string | undefined)[] {
  return members.map((m) => (m.type === "TSPropertySignature" ? keyName(m.key, m.computed) : undefined));
}

export const schemaDerivedTypes: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "A type with the same fields as a zod object schema in its file is derived from that schema" },
    messages: {
      copied:
        "`{{name}}` repeats the fields of the `z.object` on line {{line}}. Two copies drift: derive it instead, " +
        "`type {{name}} = z.infer<typeof <thatSchema>>` (or z.input), and extend or Pick from it when it differs.",
      castParse:
        "`{{schema}}.parse(...)` is cast with `as`: the schema and the type it should produce disagree. " +
        "Make the schema the source: tighten it until `z.infer<typeof {{schema}}>` is the type, and drop the cast.",
    },
    schema: [],
  },
  create(context) {
    const schemas = new Map<string, number>();
    const types: TypeShape[] = [];
    const record = (node: Node, name: string, members: Member[]) => {
      const sig = signature(memberKeys(members));
      if (sig !== undefined) types.push({ node, name, sig });
    };
    return {
      CallExpression(node) {
        const keys = zodObjectKeys(node);
        const sig = keys === undefined ? undefined : signature(keys);
        if (sig !== undefined && !schemas.has(sig)) schemas.set(sig, node.loc?.start.line ?? 0);
      },
      TSInterfaceDeclaration(node: Node) {
        const decl = node as unknown as { id: { name: string }; body: { body: Member[] } };
        record(node, decl.id.name, decl.body.body);
      },
      TSTypeLiteral(node: Node) {
        record(node, enclosingTypeName(node as unknown as Named), (node as unknown as { members: Member[] }).members);
      },
      TSAsExpression(node: Node) {
        const cast = node as unknown as { expression: Node };
        const schema = parsedSchema(cast.expression);
        if (schema !== undefined) context.report({ node, messageId: "castParse", data: { schema } });
      },
      "Program:exit"() {
        for (const { node, name, sig } of types) {
          const line = schemas.get(sig);
          if (line !== undefined) context.report({ node, messageId: "copied", data: { name, line: String(line) } });
        }
      },
    };
  },
};
