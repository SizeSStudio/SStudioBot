// Wire format of the console's config forms (DESIGN §10.6). The server describes each config file; a client only draws
// the description, so the old console and the §19 clients share one definition. Types only: nothing here runs.

export type FieldType = "text" | "number" | "bool" | "select" | "segment" | "time" | "duration" | "tags" | "multiselect" | "picker" | "kv" | "group" | "list" | "map";
/** where a picker's choices come from: FormContext.options, except `endpoints`, which is read from the form being edited */
export type OptionsFrom = "chats" | "repos" | "plugins" | "plugin_secrets" | "secrets" | "persons" | "places" | "endpoints";
export type Scalar = string | number | boolean;

export interface FieldOption { value: Scalar; label: string; help?: string }
export interface FieldCond { key: string; in: Scalar[] }
/** which direction of change loosens a limit, and what that means for the owner */
export interface FieldWiden {
  when: "up" | "down" | "on" | "change" | "add" | "remove"; note: string;
  /** clearing the value counts too (a limit that becomes no limit) */
  clearing?: boolean;
  /** order for up / down on a non-numeric value, narrowest first */
  rank?: string[];
}
export interface AddStep { title: string; help?: string; fields: string[] }
export interface AddWizard { label: string; steps: AddStep[]; defaults?: Record<string, unknown>; suggestKey?: string[] }

export interface FormField {
  /** YAML key under the parent; "." = this map's entries sit directly in the parent (jobs.yaml, repos.yaml, people.yaml) */
  key: string;
  type: FieldType;
  label: string;
  help?: string;
  unit?: string;
  placeholder?: string;
  default?: unknown;
  options?: FieldOption[];
  optionsFrom?: OptionsFrom;
  /** a choice list that also accepts a value typed by hand */
  open?: boolean;
  suggest?: string[];
  readonly?: boolean;
  /** can be set when the row is created, not afterwards */
  createOnly?: boolean;
  advanced?: boolean;
  showIf?: FieldCond;
  widen?: FieldWiden;
  /** key into FormContext.usage: what is used today, shown beside the limit */
  usage?: string;
  patternHint?: string;
  /** a key the config code reads but the zod schema lets through unnamed */
  extra?: boolean;
  // from the zod schema, filled in by the server
  required?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  integer?: boolean;
  pattern?: string;
  itemPattern?: string;
  minItems?: number;
  maxItems?: number;
  // group, list, map
  fields?: FormField[];
  /** kv: what the values are */
  valueType?: "text" | "number";
  // list and map
  removable?: boolean;
  add?: AddWizard;
  inline?: string[];
  titleFrom?: string;
  rowMeta?: "job" | "source";
  // list
  identity?: string;
  // map and kv
  keyField?: { label: string; help?: string; placeholder?: string; pattern?: string; patternHint?: string; optionsFrom?: OptionsFrom };
  keysFrom?: OptionsFrom;
  excludeKeys?: string[];
  dropWhenOnly?: string[];
  fillName?: boolean;
}

export interface FormSection { title: string; help?: string; advanced?: boolean; fields: FormField[] }
export interface FormSpec { file: string; title: string; summary: string; sections: FormSection[] }

export interface FormContext {
  options: Partial<Record<OptionsFrom, (FieldOption & { warn?: boolean })[]>>;
  usage: Record<string, number>;
  jobs?: Record<string, { next: number | null; last: { at: number; outcome: string } | null }>;
  sources?: Record<string, { at: number; ok: boolean; n: number; err?: string } | null>;
}

export interface FormFieldError { path: (string | number)[]; label: string; message: string }
export interface FormUnknown { path: string; value: string }

/** GET /api/config/<file>/form */
export interface FormPayload {
  file: string; hash: string; exists: boolean; spec: FormSpec; values: unknown; unknown: FormUnknown[]; context: FormContext;
  history: { sha: string; at: number; subject: string }[];
  /** the file does not parse: the form is read-only until it is fixed in the raw editor */
  broken?: string;
}
/** POST /api/config/<file>/form/preview: what saving this draft would do. Writes nothing. */
export interface FormPreview {
  stale: boolean; changed: boolean; errors: FormFieldError[]; widened: string[]; notes: string[]; diff: string;
  computed?: { next?: Record<string, number | null> };
}
