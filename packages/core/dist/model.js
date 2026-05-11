/**
 * Creates a ContractModel from metadata and a validator function.
 *
 * In production, validators are typically generated from Concerto .cto files
 * or defined with Zod schemas. For the SDK core we keep this generic.
 */
export function defineModel(meta, validator) {
    return {
        meta,
        is: validator,
        serialize(data) {
            return JSON.stringify(data, null, 2);
        },
        deserialize(json) {
            const parsed = JSON.parse(json);
            if (!validator(parsed)) {
                throw new Error(`Invalid contract data for ${meta.namespace}.${meta.name}`);
            }
            return parsed;
        },
    };
}
//# sourceMappingURL=model.js.map