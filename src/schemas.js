// Hand-rolled validation (NOT the npm "zod" package: this build environment has no network).
// Same idea: declare a shape, parse untrusted input, get back only known, validated fields.
import { ValidationError } from './errors.js';

const str = (o = {}) => ({
  kind: 'string', required: o.required !== false, min: o.min ?? 1, max: o.max ?? 10000,
  pattern: o.pattern, trim: o.trim !== false,
});
const opt = (o = {}) => str({ ...o, required: false });
const enm = (values, o = {}) => ({ kind: 'enum', values, required: o.required !== false });

function object(shape) {
  return {
    parse(data) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new ValidationError('Request body must be a JSON object.', [{ path: '', message: 'expected object' }]);
      }
      const issues = [];
      const out = {};
      for (const [key, f] of Object.entries(shape)) {
        const raw = data[key];
        if (raw === undefined || raw === null) {
          if (f.required) issues.push({ path: key, message: `"${key}" is required.` });
          continue;
        }
        if (f.kind === 'string') {
          if (typeof raw !== 'string') { issues.push({ path: key, message: `"${key}" must be text.` }); continue; }
          const v = f.trim ? raw.trim() : raw;
          if (v.length < f.min) {
            issues.push({ path: key, message: v.length === 0 ? `"${key}" must not be empty.` : `"${key}" must be at least ${f.min} characters.` });
            continue;
          }
          if (v.length > f.max) { issues.push({ path: key, message: `"${key}" must be at most ${f.max} characters.` }); continue; }
          if (f.pattern && !f.pattern.test(v)) { issues.push({ path: key, message: `"${key}" is not valid.` }); continue; }
          out[key] = v;
        } else if (f.kind === 'enum') {
          if (typeof raw !== 'string' || !f.values.includes(raw)) {
            issues.push({ path: key, message: `"${key}" must be one of: ${f.values.join(', ')}.` });
            continue;
          }
          out[key] = raw;
        }
      }
      if (issues.length) throw new ValidationError('Request body failed validation.', issues);
      return out; // unknown keys are dropped on purpose (no mass-assignment)
    },
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const signupSchema = object({
  email: str({ max: 254, pattern: EMAIL }),
  password: str({ min: 8, max: 200, trim: false }),
  businessName: str({ max: 100 }),
});
export const loginSchema = object({
  email: str({ max: 254 }),
  password: str({ max: 200, trim: false }),
});
export const knowledgeCreateSchema = object({
  title: str({ max: 200 }),
  body: str({ max: 20000 }),
});
export const knowledgeUpdateSchema = object({
  title: opt({ max: 200 }),
  body: opt({ max: 20000 }),
  status: enm(['ACTIVE', 'ARCHIVED'], { required: false }),
});
export const approveSchema = object({ editedBody: opt({ max: 1500 }) });
export const replySchema = object({ body: str({ max: 1500 }) });
export const widgetMessageSchema = object({ message: str({ max: 1000 }) });
