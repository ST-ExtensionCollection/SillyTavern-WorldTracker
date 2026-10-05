// WorldTracker — fires the tracker request.
//
// Preferred path: a saved Connection Manager profile (a SEPARATE request that
// does not disturb the main chat or its connection). Fallback: the main API via
// generateRaw / generateQuietPrompt.

import { log, warn, vlog } from './log.js';

/** List connection profiles, if the Connection Manager is present. */
export function listProfiles(ctx) {
    return ctx?.extensionSettings?.connectionManager?.profiles ?? [];
}

function textFrom(out) {
    if (out == null) return '';
    if (typeof out === 'string') return out;
    const c = out.content ?? out.text ?? out.message?.content
        ?? out.choices?.[0]?.message?.content ?? out.choices?.[0]?.text ?? '';
    // With json_schema, ST may hand back an already-parsed object.
    return typeof c === 'object' ? JSON.stringify(c) : c;
}

/** Wrap a bare JSON Schema in the { name, strict, value } envelope ST expects.
 *  openai.js forwards the whole `jsonSchema` option as generate_data.json_schema,
 *  and the consumer reads `name`/`strict`/`value` from it to build the wire
 *  response_format — a `schema`-keyed envelope puts name+strict on the wire but
 *  leaves schema undefined (confirmed by request logs), while a bare schema
 *  object leaves all three unset. */
function schemaEnvelope(schema) {
    if (schema?.type === 'json_schema' && schema.json_schema) {
        const e = schema.json_schema;
        return { name: e.name ?? 'WorldTrackerState', strict: e.strict ?? false, value: e.schema ?? e.value };
    }
    return { name: 'WorldTrackerState', strict: false, value: schema };
}

/**
 * @param {{role,content}[]} messages
 * @param {object} settings
 * @param {object} ctx  SillyTavern context
 * @param {AbortSignal} [signal]
 * @param {object} [schema]  JSON Schema for structured output
 * @returns {Promise<string>} raw response text
 */
export async function runTrackerRequest(messages, settings, ctx, signal, schema) {
    // Give a reasoning model room to think AND still write the JSON.
    const answerTokens = Number(settings.maxResponseTokens) || 1024;
    const thinkTokens = Math.max(0, Number(settings.maxThinkTokens) || 0);
    const maxTokens = answerTokens + thinkTokens;

    const override = {};
    if (settings.reasoningEffort) override.reasoning_effort = settings.reasoningEffort;
    if (settings.structuredOutput && schema) {
        // The connection service recognizes the `json_schema` override key
        // (a `response_format` override is silently dropped) and builds the
        // wire response_format from the object's `name`/`strict`/`value` fields.
        override.json_schema = schemaEnvelope(schema);
    }

    const profiles = listProfiles(ctx);
    const profile = settings.profileId && profiles.find((p) => p.id === settings.profileId);

    // Opt-in: pull samplers (temperature, DRY, rep pen, XTC…) and the instruct
    // template from whatever preset the chosen connection profile binds. Off by
    // default — the tracker wants deterministic JSON, not RP samplers.
    const inheritPreset = !!settings.inheritPreset;

    if (profile && ctx.ConnectionManagerRequestService) {
        log(`request via connection profile "${profile.name}" (max_tokens ${maxTokens}, effort ${settings.reasoningEffort || 'default'}, preset ${inheritPreset ? 'inherited' : 'off'}, ${override.json_schema ? 'json_schema attached' : 'no schema'})`);
        // Stream it: a non-streaming request runs to completion on the backend
        // even after the client aborts (the abort only lands at send time). A
        // streamed request dies the moment the connection drops — that's how
        // ST's own Stop button cancels KoboldCPP cleanly.
        const out = await ctx.ConnectionManagerRequestService.sendRequest(
            profile.id,
            messages,
            maxTokens,
            { stream: true, extractData: true, signal, includePreset: inheritPreset, includeInstruct: inheritPreset },
            override,
        );
        if (typeof out === 'function') {
            let text = '';
            for await (const chunk of out()) {
                if (signal?.aborted) break;
                text = typeof chunk === 'string' ? chunk : (chunk?.text ?? text);
            }
            return text;
        }
        return textFrom(out);
    }

    if (profile && !ctx.ConnectionManagerRequestService) {
        warn('profile set but ConnectionManagerRequestService unavailable — using main API');
    }

    const flat = messages.map((m) => (m.role === 'system' ? m.content : m.content)).join('\n\n');
    const sysMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userMsg = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');

    if (typeof ctx.generateRaw === 'function') {
        log(`request via main API (generateRaw)${(settings.structuredOutput && schema) ? ', json_schema attached' : ', no schema'}`);
        vlog('generateRaw options (exact):', JSON.stringify({
            responseLength: maxTokens,
            jsonSchema: (settings.structuredOutput && schema) ? schemaEnvelope(schema) : null,
        }, (k, v) => (k === 'value' ? `${JSON.stringify(v).slice(0, 200)}…` : v)));
        return await ctx.generateRaw({
            prompt: userMsg || flat,
            systemPrompt: sysMsg,
            responseLength: maxTokens,
            // The whole option object is forwarded as json_schema; the server
            // builds response_format from its name/strict/value fields.
            jsonSchema: (settings.structuredOutput && schema)
                ? schemaEnvelope(schema)
                : null,
        });
    }

    if (typeof ctx.generateQuietPrompt === 'function') {
        log('request via main API (generateQuietPrompt)');
        return await ctx.generateQuietPrompt(flat, false, false);
    }

    throw new Error('no generation method available (no profile, no generateRaw/generateQuietPrompt)');
}
