export type InteractionActiveRunHint = {
  runId: string;
  generation: number;
};

export type InteractionRequestMetadata = {
  requestId: string;
  idempotencyKey: string;
  activeRunHint?: InteractionActiveRunHint;
};

type SubmitOptions = {
  config?: {
    configurable?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isInteractionActiveRunHint(
  value: unknown
): value is InteractionActiveRunHint {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.runId === 'string' &&
      RUN_ID_PATTERN.test(record.runId) &&
      typeof record.generation === 'number' &&
      Number.isSafeInteger(record.generation) &&
      record.generation > 0
  );
}

function parseInteractionRequestMetadata(
  value: unknown
): InteractionRequestMetadata | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.requestId !== 'string' ||
    !UUID_V4_PATTERN.test(record.requestId) ||
    typeof record.idempotencyKey !== 'string' ||
    !UUID_V4_PATTERN.test(record.idempotencyKey)
  ) {
    return undefined;
  }

  const hint = record.activeRunHint;
  if (hint !== undefined && !isInteractionActiveRunHint(hint)) {
    return undefined;
  }

  return {
    requestId: record.requestId,
    idempotencyKey: record.idempotencyKey,
    ...(hint && isInteractionActiveRunHint(hint) ? { activeRunHint: hint } : {}),
  };
}

function extractBodyMetadata(body: BodyInit | null | undefined): {
  present: boolean;
  metadata?: InteractionRequestMetadata;
} {
  if (typeof body !== 'string') return { present: false };
  try {
    const bodyRecord = asRecord(JSON.parse(body));
    const config = asRecord(bodyRecord?.config);
    const configurable = asRecord(config?.configurable);
    const rawMetadata = configurable?.clientInteractionMetadata;
    return rawMetadata === undefined
      ? { present: false }
      : { present: true, metadata: parseInteractionRequestMetadata(rawMetadata) };
  } catch {
    return { present: false };
  }
}

export function createInteractionRequestMetadata(
  activeRunHint?: InteractionActiveRunHint,
  createUuid: () => string = () => crypto.randomUUID()
): InteractionRequestMetadata {
  const requestId = createUuid();
  const idempotencyKey = createUuid();
  if (!UUID_V4_PATTERN.test(requestId) || !UUID_V4_PATTERN.test(idempotencyKey)) {
    throw new TypeError('Invalid generated interaction request metadata');
  }
  return {
    requestId,
    idempotencyKey,
    ...(activeRunHint && isInteractionActiveRunHint(activeRunHint)
      ? { activeRunHint }
      : {}),
  };
}

export function withInteractionRequestMetadata<TOptions extends SubmitOptions>(
  options: TOptions,
  metadata: InteractionRequestMetadata
): TOptions {
  const validated = parseInteractionRequestMetadata(metadata);
  if (!validated) return options;
  return {
    ...options,
    config: {
      ...options.config,
      configurable: {
        ...options.config?.configurable,
        clientInteractionMetadata: validated,
      },
    },
  };
}

export function createInteractionMetadataFetch(
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis)
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    const bodyMetadata = extractBodyMetadata(init?.body);
    if (bodyMetadata.present) {
      for (const name of [
        'x-request-id',
        'x-idempotency-key',
        'x-active-run-id',
        'x-active-run-generation',
      ]) headers.delete(name);
    }
    const metadata = bodyMetadata.metadata;
    if (metadata) {
      headers.set('x-request-id', metadata.requestId);
      headers.set('x-idempotency-key', metadata.idempotencyKey);
      if (metadata.activeRunHint) {
        headers.set('x-active-run-id', metadata.activeRunHint.runId);
        headers.set(
          'x-active-run-generation',
          String(metadata.activeRunHint.generation)
        );
      }
    }
    return baseFetch(input, { ...init, headers });
  };
}
