/**
 * @file test/fixtures/fixture-provider.ts
 * @description A deterministic, credential-free test model that compile
 * witnesses run the real compile under.
 *
 * It is a real {@link LLMProvider}: the shared extraction and page-generation
 * code calls it exactly as it would call any provider, and `propose` still
 * requires `model.invoke`. What it changes is who answers. Every answer is a
 * pure function of the bytes it was handed, so the same inputs always yield
 * the same candidates, and a changed input (a source, the index, a context
 * page) visibly changes the output. It reads no environment and no network.
 *
 * It reports its own identity. A draft it generates is stamped with
 * {@link FIXTURE_MODEL_ID}, never with whatever provider the environment names.
 */

import { createHash } from "node:crypto";
import type { LLMMessage, LLMProvider, LLMTool, ProviderOverride } from "../../src/utils/provider.js";

/** The provider name fixture-generated work is attributed to. */
const FIXTURE_PROVIDER_NAME = "portable-fixture";

/** The model id stamped into fixture-generated page provenance. */
export const FIXTURE_MODEL_ID = "portable-fixture-v1";

/** Marker the shared extraction prompt puts before the source text. */
const SOURCE_MARKER = "--- SOURCE DOCUMENT ---";

/** Longest concept title the fixture derives. */
const MAX_TITLE_CHARS = 80;

/** Hex characters of the input digest shown in a generated page. */
const DIGEST_PREFIX_CHARS = 16;

/** The non-empty lines of `text` after any leading frontmatter block. */
function contentLines(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/u, "");
  return body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** One concept per source: its first heading (or first line) and its first prose line. */
function extractConcept(system: string): { concept: string; summary: string } | null {
  const at = system.indexOf(SOURCE_MARKER);
  const lines = contentLines(at < 0 ? "" : system.slice(at + SOURCE_MARKER.length));
  if (lines.length === 0) return null;
  const heading = lines.find((line) => line.startsWith("#")) ?? lines[0];
  const concept = heading.replace(/^#+\s*/u, "").slice(0, MAX_TITLE_CHARS).trim();
  const summary = lines.find((line) => !line.startsWith("#")) ?? concept;
  return concept ? { concept, summary } : null;
}

/** The concept a page-generation call names in its user message. */
function requestedConcept(messages: LLMMessage[]): string {
  const text = String(messages[0]?.content ?? "");
  return /"(.+)"/u.exec(text)?.[1] ?? "Untitled";
}

/** A deterministic provider whose answers depend only on its inputs. */
export class FixtureProvider implements LLMProvider {
  async complete(system: string, messages: LLMMessage[]): Promise<string> {
    const concept = requestedConcept(messages);
    const digest = createHash("sha256").update(system).digest("hex").slice(0, DIGEST_PREFIX_CHARS);
    return [
      "## Overview", "",
      `${concept} is described by the supplied source material.`, "",
      `Deterministic fixture output for input ${digest}.`,
    ].join("\n");
  }

  async stream(
    system: string, messages: LLMMessage[], _maxTokens: number, onToken?: (text: string) => void,
  ): Promise<string> {
    const text = await this.complete(system, messages);
    onToken?.(text);
    return text;
  }

  async toolCall(system: string, _messages: LLMMessage[], _tools: LLMTool[]): Promise<string> {
    const found = extractConcept(system);
    const concepts = found === null ? [] : [{
      ...found, is_new: true, tags: ["fixture"], confidence: 1, provenance_state: "extracted",
    }];
    return JSON.stringify({ concepts });
  }

  /** The prototype compile needs no embeddings; asking for one is a bug, not a fallback. */
  async embed(): Promise<number[]> {
    throw new Error("the portable fixture model provides no embeddings");
  }
}

/** The run-scoped override that makes the fixture answer, and be named as, the model. */
export function fixtureModelOverride(): ProviderOverride {
  return { provider: new FixtureProvider(), providerName: FIXTURE_PROVIDER_NAME, modelId: FIXTURE_MODEL_ID };
}
