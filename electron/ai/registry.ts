/**
 * Provider catalogue. Pure data: which protocol each provider speaks, its default base
 * URL, and the environment variables its docs conventionally use for the API key.
 * Model names are deliberately NOT listed for non-Anthropic providers: they go stale, so
 * the model picker is filled from each provider's own models endpoint.
 */
export type ProviderKind = 'anthropic' | 'openai-compatible' | 'gemini';

export type ProviderDef = {
  /** Lower-case id; also used in file names and settings keys. */
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string | null;
  baseUrlEditable: boolean;
  /** Checked in order; the first non-empty value is used when no key is stored. */
  envVars: readonly string[];
  /** Custom endpoints may legitimately need no key. */
  keyOptional: boolean;
  /** Only set where the id is stable enough to ship. */
  defaultModel: string | null;
  /** The wire format could not be fully verified against a live key. */
  experimental: boolean;
  note: string | null;
};

const compat = (
  def: Pick<ProviderDef, 'id' | 'label' | 'baseUrl' | 'envVars'> &
    Partial<Pick<ProviderDef, 'experimental' | 'note'>>,
): ProviderDef => ({
  kind: 'openai-compatible',
  baseUrlEditable: false,
  keyOptional: false,
  defaultModel: null,
  experimental: false,
  note: null,
  ...def,
});

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: null,
    baseUrlEditable: false,
    envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    keyOptional: false,
    defaultModel: 'claude-opus-5-5',
    experimental: false,
    note: null,
  },
  compat({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envVars: ['OPENAI_API_KEY'],
    note: 'Sends model, messages and stream only. Whether the newest OpenAI models accept this minimal request could not be verified.',
  }),
  {
    id: 'google',
    label: 'Google (Gemini)',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: false,
    // Google documents that GOOGLE_API_KEY wins when both are set.
    envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    keyOptional: false,
    defaultModel: null,
    experimental: true,
    note: 'Experimental: the stream format and error shape could not be verified without a live key.',
  },
  compat({
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envVars: ['MISTRAL_API_KEY'],
  }),
  compat({
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envVars: ['GROQ_API_KEY'],
  }),
  compat({
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVars: ['OPENROUTER_API_KEY'],
    note: 'The environment variable name is a convention; OpenRouter documents only a placeholder.',
  }),
  compat({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    envVars: ['DEEPSEEK_API_KEY'],
  }),
  compat({
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    envVars: ['TOGETHER_API_KEY'],
    note: 'Together does not document a [DONE] end marker; the stream closing ends the answer.',
  }),
  compat({
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    envVars: ['XAI_API_KEY'],
    experimental: true,
    note: 'Experimental: the docs fetched only describe the Responses API, so Chat Completions support is unconfirmed.',
  }),
  {
    ...compat({ id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: null, envVars: [] }),
    baseUrlEditable: true,
    keyOptional: true,
    note: 'Any endpoint that speaks the OpenAI Chat Completions protocol over https.',
  },
];

export const DEFAULT_PROVIDER_ID = 'anthropic';

export function getProvider(id: string): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}
