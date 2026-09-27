import { type ToolCallRequest, type ToolDefinition, type ToolOutcome, type ToolRegistry, type Tools } from './types';

/**
 * Merges registries into the tools the LLM may call, routing each call to the registry that
 * defined the tool. Throws on duplicate tool names. Calls with unparsed arguments or unknown
 * names never reach a registry; registry failures become `ok: false` outcomes.
 */
export function createTools(registries: readonly ToolRegistry[]): Tools {
  const owners = new Map<string, ToolRegistry>();
  const definitions: ToolDefinition[] = [];

  for (const registry of registries) {
    for (const definition of registry.definitions) {
      if (owners.has(definition.name)) {
        throw new Error(`Duplicate tool name: ${definition.name}`);
      }
      owners.set(definition.name, registry);
      definitions.push(definition);
    }
  }

  return {
    definitions,
    async call(request: ToolCallRequest, context): Promise<ToolOutcome> {
      const { name } = request;
      if (request.argumentsError) {
        return { ok: false, name, error: request.argumentsError };
      }
      const owner = owners.get(name);
      if (!owner) {
        return { ok: false, name, error: `Unknown tool: ${name}` };
      }
      try {
        return { ok: true, name, result: await owner.execute(name, request.arguments, context) };
      } catch (error) {
        return { ok: false, name, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
