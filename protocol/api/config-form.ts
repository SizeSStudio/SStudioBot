// Wire format of the config forms (DESIGN §触5.6, docs/tech/10 「core/protocol/config-form.ts」). The hub describes
// each config file; a client only draws the description. Ported from core/protocol/config-form.ts (types) to zod, so
// hub and clients share one definition and protocol-check keeps it growing only.
import { z } from "zod";

export const FieldType = z.enum(["text", "number", "bool", "select", "segment", "time", "duration", "tags", "multiselect", "picker", "kv", "group", "list", "map"]);
export type FieldType = z.infer<typeof FieldType>;
/** where a picker's choices come from: FormContext.options, except `endpoints`, which is read from the form being edited */
export const OptionsFrom = z.enum(["chats", "repos", "plugins", "plugin_secrets", "secrets", "persons", "places", "endpoints", "nodes", "push_cats"]);
export type OptionsFrom = z.infer<typeof OptionsFrom>;
export const Scalar = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof Scalar>;

export const FieldOption = z.object({ value: Scalar, label: z.string(), help: z.string().optional() });
export type FieldOption = z.infer<typeof FieldOption>;
export const FieldCond = z.object({ key: z.string(), in: z.array(Scalar) });
export type FieldCond = z.infer<typeof FieldCond>;
/** which direction of change loosens something, and what that means for me */
export const FieldWiden = z.object({
  when: z.enum(["up", "down", "on", "off", "change", "add", "remove"]),
  note: z.string(),
  /** clearing the value counts too (a limit that becomes no limit) */
  clearing: z.boolean().optional(),
  /** order for up / down on a non-numeric value, narrowest first */
  rank: z.array(z.string()).optional(),
});
export type FieldWiden = z.infer<typeof FieldWiden>;
export const AddStep = z.object({ title: z.string(), help: z.string().optional(), fields: z.array(z.string()) });
export type AddStep = z.infer<typeof AddStep>;
export const AddWizard = z.object({
  label: z.string(), steps: z.array(AddStep), defaults: z.record(z.string(), z.unknown()).optional(), suggestKey: z.array(z.string()).optional(),
});
export type AddWizard = z.infer<typeof AddWizard>;
export const KeyField = z.object({
  label: z.string(), help: z.string().optional(), placeholder: z.string().optional(), pattern: z.string().optional(),
  patternHint: z.string().optional(), optionsFrom: OptionsFrom.optional(),
});

export interface FormField {
  key: string; type: FieldType; label: string; help?: string; unit?: string; placeholder?: string; default?: unknown;
  options?: FieldOption[]; optionsFrom?: OptionsFrom; open?: boolean; suggest?: string[]; readonly?: boolean;
  createOnly?: boolean; advanced?: boolean; showIf?: FieldCond; widen?: FieldWiden; usage?: string; patternHint?: string;
  extra?: boolean; required?: boolean; min?: number; max?: number; exclusiveMin?: number; integer?: boolean;
  pattern?: string; itemPattern?: string; minItems?: number; maxItems?: number; fields?: FormField[];
  valueType?: "text" | "number"; removable?: boolean; add?: AddWizard; inline?: string[]; titleFrom?: string;
  rowMeta?: "job" | "source"; identity?: string; keyField?: z.infer<typeof KeyField>; keysFrom?: OptionsFrom;
  excludeKeys?: string[]; dropWhenOnly?: string[]; fillName?: boolean;
}

export const FormField: z.ZodType<FormField> = z.object({
  /** YAML key under the parent; "." = this map's entries sit directly in the parent (jobs.yaml, repos.yaml, people.yaml) */
  key: z.string(),
  type: FieldType,
  label: z.string(),
  help: z.string().optional(),
  unit: z.string().optional(),
  placeholder: z.string().optional(),
  default: z.unknown().optional(),
  options: z.array(FieldOption).optional(),
  optionsFrom: OptionsFrom.optional(),
  /** a choice list that also accepts a value typed by hand */
  open: z.boolean().optional(),
  suggest: z.array(z.string()).optional(),
  readonly: z.boolean().optional(),
  /** can be set when the row is created, not afterwards */
  createOnly: z.boolean().optional(),
  advanced: z.boolean().optional(),
  showIf: FieldCond.optional(),
  widen: FieldWiden.optional(),
  /** key into FormContext.usage: what is used today, shown beside the line */
  usage: z.string().optional(),
  patternHint: z.string().optional(),
  /** a key the config code reads but the zod schema lets through unnamed */
  extra: z.boolean().optional(),
  // from the zod schema, filled in by the hub
  required: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  exclusiveMin: z.number().optional(),
  integer: z.boolean().optional(),
  pattern: z.string().optional(),
  itemPattern: z.string().optional(),
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
  // group, list, map
  get fields() { return z.array(FormField).optional(); },
  /** kv: what the values are */
  valueType: z.enum(["text", "number"]).optional(),
  // list and map
  removable: z.boolean().optional(),
  add: AddWizard.optional(),
  inline: z.array(z.string()).optional(),
  titleFrom: z.string().optional(),
  rowMeta: z.enum(["job", "source"]).optional(),
  // list
  identity: z.string().optional(),
  // map and kv
  keyField: KeyField.optional(),
  keysFrom: OptionsFrom.optional(),
  excludeKeys: z.array(z.string()).optional(),
  dropWhenOnly: z.array(z.string()).optional(),
  fillName: z.boolean().optional(),
});

export const FormSection = z.object({ title: z.string(), help: z.string().optional(), advanced: z.boolean().optional(), fields: z.array(FormField) });
export type FormSection = z.infer<typeof FormSection>;
export const FormSpec = z.object({ file: z.string(), title: z.string(), summary: z.string(), sections: z.array(FormSection) });
export type FormSpec = z.infer<typeof FormSpec>;

export const FormContext = z.object({
  options: z.record(z.string(), z.array(FieldOption.extend({ warn: z.boolean().optional() }))),
  usage: z.record(z.string(), z.number()),
  jobs: z.record(z.string(), z.object({
    next: z.number().nullable(), last: z.object({ at: z.number(), outcome: z.string() }).nullable(),
  })).optional(),
  sources: z.record(z.string(), z.object({ at: z.number(), ok: z.boolean(), n: z.number(), err: z.string().optional() }).nullable()).optional(),
});
export type FormContext = z.infer<typeof FormContext>;

export const FormFieldError = z.object({ path: z.array(z.union([z.string(), z.number()])), label: z.string(), message: z.string() });
export type FormFieldError = z.infer<typeof FormFieldError>;
export const FormUnknown = z.object({ path: z.string(), value: z.string() });
export type FormUnknown = z.infer<typeof FormUnknown>;

/** GET /api/v1/config/:file/form */
export const FormPayload = z.object({
  file: z.string(), hash: z.string(), exists: z.boolean(), spec: FormSpec, values: z.unknown(), unknown: z.array(FormUnknown),
  context: FormContext,
  history: z.array(z.object({ sha: z.string(), at: z.number(), subject: z.string() })),
  /** the file does not parse: the form is read-only until it is fixed in the raw editor */
  broken: z.string().optional(),
});
export type FormPayload = z.infer<typeof FormPayload>;
/** POST /api/v1/config/:file/form/preview: what saving this draft would do. Writes nothing. */
export const FormPreview = z.object({
  stale: z.boolean(), changed: z.boolean(), errors: z.array(FormFieldError), widened: z.array(z.string()), notes: z.array(z.string()),
  diff: z.string(),
  computed: z.object({ next: z.record(z.string(), z.number().nullable()).optional() }).optional(),
});
export type FormPreview = z.infer<typeof FormPreview>;
