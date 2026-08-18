import type { Tool } from "./types.js";

export class ToolRegistryError extends Error {
  override readonly name = "ToolRegistryError" as const;
}

// Tools are looked up by name only; version-per-household pinning is a
// later addition that would slot in here without touching agents.
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register<I, O>(tool: Tool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool);
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new ToolRegistryError(`Unknown tool: ${name}`);
    return t;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }
}
