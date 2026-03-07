import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startActiveObservation } from "@langfuse/tracing";

let sdk: NodeSDK | null = null;

export function initTracing() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey || !baseUrl) {
    console.log("LangFuse keys not set, tracing disabled");
    return;
  }

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
  });

  sdk = new NodeSDK({
    spanProcessors: [processor],
  });

  sdk.start();
  console.log("LangFuse tracing initialized (OTel SDK)");
}

export async function traceAgent<T>(
  name: string,
  input: string,
  metadata: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sdk) return fn();

  return startActiveObservation(name, async (span) => {
    span.update({
      input: { prompt: input },
      metadata,
    });

    try {
      const result = await fn();

      // Create a child generation for the LLM call
      await startActiveObservation(
        "claude-sdk-query",
        async (gen) => {
          gen.update({
            model: "claude-sonnet-4-6",
            input: { prompt: input },
            output: { response: result },
          });
        },
        { asType: "generation" },
      );

      span.update({
        output: { response: result },
      });

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.update({
        output: { error: errMsg },
        level: "ERROR",
        statusMessage: errMsg,
      });
      throw err;
    }
  });
}

export async function shutdownTracing() {
  if (sdk) {
    await sdk.shutdown();
  }
}
