/**
 * Creates a ContractTemplate backed by a simple Handlebars-style renderer.
 *
 * Variables use {{dotted.path}} syntax matching Cicero conventions.
 * Nested access (e.g. {{disclosingParty.name}}) is supported.
 */
export function defineTemplate(model, text) {
    return {
        model,
        text,
        draft(data) {
            return text.replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
                const value = resolvePath(data, path);
                return value !== undefined ? String(value) : match;
            });
        },
        parse(contractText) {
            const vars = extractVariables(text);
            const result = {};
            for (const varPath of vars) {
                const pattern = buildExtractionPattern(text, varPath);
                const match = pattern ? contractText.match(pattern) : null;
                if (match?.[1]) {
                    setPath(result, varPath, match[1].trim());
                }
            }
            return result;
        },
        variables() {
            return extractVariables(text);
        },
    };
}
function extractVariables(tmpl) {
    const matches = [...tmpl.matchAll(/\{\{([\w.]+)\}\}/g)];
    return [...new Set(matches.map((m) => m[1]))];
}
function resolvePath(obj, path) {
    return path.split(".").reduce((acc, key) => {
        if (acc !== null && typeof acc === "object" && key in acc) {
            return acc[key];
        }
        return undefined;
    }, obj);
}
function setPath(obj, path, value) {
    const keys = path.split(".");
    let cursor = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!(key in cursor) || typeof cursor[key] !== "object") {
            cursor[key] = {};
        }
        cursor = cursor[key];
    }
    const lastKey = keys[keys.length - 1];
    cursor[lastKey] = value;
}
/**
 * Builds a regex that captures the value of a specific {{variable}} by using
 * the surrounding literal text in the template as anchors.
 * This is heuristic — a production implementation would use a proper parser.
 */
function buildExtractionPattern(tmpl, varPath) {
    const placeholder = `{{${varPath}}}`;
    const idx = tmpl.indexOf(placeholder);
    if (idx === -1)
        return null;
    const before = tmpl.slice(Math.max(0, idx - 40), idx);
    const after = tmpl.slice(idx + placeholder.length, idx + placeholder.length + 40);
    const anchor = before.split(/\s+/).slice(-3).join("\\s+");
    const tail = after.split(/\s+/).slice(0, 3).join("\\s+");
    try {
        return new RegExp(`${anchor}\\s*([^\\n]+?)\\s*${tail}`);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=template.js.map