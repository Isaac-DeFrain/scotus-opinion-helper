/**
 * Weaviate client
 *
 * This file contains the functions to connect to the Weaviate instance.
 */

import weaviate, { WeaviateClient } from "weaviate-client";
import { z } from "zod";

import { EMBEDDING_DIMENSIONS, WEAVIATE_COLLECTION_NAME } from "./constants";
import { OpinionChunk } from "./opinion";
import { delay } from "./utils";

const NEAR_VECTOR_LIMIT = 20;
const OBJECTS_PER_GROUP = 2;

export const weaviateChunkRowSchema = z.object({
  docket: z.string(),
  chunk_index: z.number().int().nonnegative(),
  total_chunks: z.number().int().positive(),
  content: z.string(),
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
  start_char: z.number().int().nonnegative(),
  end_char: z.number().int().nonnegative(),
  case_name: z.string(),
  opinion_type: z.string(),
  date: z.number(),
  justice: z.string(),
  term_year: z.number().int(),
  created_at: z.number(),
});

export type WeaviateChunkRow = z.infer<typeof weaviateChunkRowSchema>;

/**
 * Parse the Weaviate URL
 *
 * @param raw - The raw Weaviate URL
 * @returns The parsed Weaviate URL
 */
function parseWeaviateUrl(raw: string): {
  httpHost: string;
  httpPort: number;
  httpSecure: boolean;
  grpcHost: string;
  grpcPort: number;
  grpcSecure: boolean;
} {
  const url = new URL(raw);

  const httpHost = url.hostname;
  const httpPort = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  const httpSecure = url.protocol === "https:";

  // Default gRPC port for Weaviate is 50051 in our compose.
  const grpcHost = httpHost;
  const grpcPort = 50051;
  const grpcSecure = httpSecure;

  return { httpHost, httpPort, httpSecure, grpcHost, grpcPort, grpcSecure };
}

const CONNECT_RETRIES = 15;
const CONNECT_RETRY_DELAY_MS = 5000;

/**
 * Connect to the Weaviate instance, retrying on transient startup failures.
 * The Docker healthcheck gates on HTTP readiness, but the gRPC port may take
 * a moment longer — retries cover that gap.
 *
 * @returns The Weaviate client
 */
export async function connectWeaviate(): Promise<
  Awaited<ReturnType<typeof weaviate.connectToLocal>>
> {
  const raw = process.env.WEAVIATE_URL?.trim() || "http://localhost:8080";

  const connect = () => {
    if (raw === "http://localhost:8080") {
      return weaviate.connectToLocal();
    }

    const { httpHost, httpPort, httpSecure, grpcHost, grpcPort, grpcSecure } =
      parseWeaviateUrl(raw);

    return weaviate.connectToCustom({
      httpHost,
      httpPort,
      httpSecure,
      grpcHost,
      grpcPort,
      grpcSecure,
    });
  };

  let error: Error | unknown;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      return await connect();
    } catch (err) {
      if (attempt === CONNECT_RETRIES) {
        error = err as Error;
        break;
      }

      console.warn(
        `Weaviate connection attempt ${attempt}/${CONNECT_RETRIES} failed, retrying in ${CONNECT_RETRY_DELAY_MS}ms…`,
      );

      await delay(CONNECT_RETRY_DELAY_MS);
    }
  }

  throw error;
}

/**
 * Removes chunks whose trimmed text is identical to an earlier chunk,
 * preserving the first (closest) occurrence.
 *
 * @param chunks - Chunks sorted by ascending distance
 * @returns Deduplicated chunks in the same order
 */
function deduplicateByContent(chunks: OpinionChunk[]): OpinionChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    const text = c.text.trim();

    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

/**
 * Searches the Weaviate collection for opinion chunks nearest to the given
 * query vector.
 *
 * @param client - An open Weaviate client
 * @param queryVector - The embedding vector to search against
 * @param limit - Maximum number of results to return
 * @returns Matched opinion chunks with non-empty text
 */
export async function searchDocuments(
  client: WeaviateClient,
  query: string,
  queryVector: number[],
  limit = NEAR_VECTOR_LIMIT,
): Promise<OpinionChunk[]> {
  const collection = client.collections.get<OpinionChunk>(
    WEAVIATE_COLLECTION_NAME,
  );

  const result = await collection.query.hybrid(query, {
    vector: queryVector,
    alpha: 0.5,
    queryProperties: ["text"],
    limit,
    groupBy: {
      property: "docket",
      objectsPerGroup: OBJECTS_PER_GROUP,
      numberOfGroups: NEAR_VECTOR_LIMIT,
    },
    returnProperties: [
      "text",
      "docket",
      "caseName",
      "opinionType",
      "date",
      "justice",
      "termYear",
      "chunkIndex",
      "totalChunks",
    ],
    returnMetadata: ["score"],
  });

  return deduplicateByContent(
    result.objects
      .filter((p) => p.properties.text.trim().length > 0)
      .sort((a, b) => (b.metadata?.score ?? 0) - (a.metadata?.score ?? 0))
      .map((o) => o.properties),
  );
}

/**
 * Connects to Weaviate client, exiting the process with an error message on failure.
 */
export async function connectWeaviateOrExit(): Promise<WeaviateClient> {
  try {
    return await connectWeaviate();
  } catch (err) {
    console.error("Could not connect to Weaviate:", (err as Error).message);
    console.error("Run `docker compose up -d` to start Weaviate.");
    process.exit(1);
  }
}
