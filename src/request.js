// WorldTracker — fires the tracker request.
//
// Preferred path: a saved Connection Manager profile (a SEPARATE request that
// does not disturb the main chat or its connection). Fallback: the main API via
// generateRaw / generateQuietPrompt.

import { log, warn } from './log.js';

/** List connection profiles, if the Connection Manager is present. */
export function listProfiles(ctx) {
    return ctx?.extensionSettings?.connectionManager?.profiles ?? [];
}

function textFrom(out) {
    if (out == null) return '';
    if (typeof out === 'string') return out;
    return out.content ?? out.text ?? out.message?.content
        ?? out.choices?.[0]?.message?.content ?? out.choices?.[0]?.text ?? '';
}

/**
 * @param {{role,content}[]} messages
 * @param {object} settings
 * @param {object} ctx  SillyTavern context
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} raw response text
 */
export async function runTrackerRequest(messages, settings, ctx, signal) {
    // Give a reasoning model room to think AND still write the JSON.
    const answerTokens = Number(settings.maxResponseTokens) || 1024;
    const thinkTokens = Math.max(0, Number(settings.maxThinkTokens) || 0);
    const maxTokens = answerTokens + thinkTokens;

    const override = {};
    if (settings.reasoningEffort) override.reasoning_effort = settings.reasoningEffort;

    const profiles = listProfiles(ctx);
    const profile = settings.profileId && profiles.find((p) => p.id === settings.profileId);

    if (profile && ctx.ConnectionManagerRequestService) {
        log(`request via connection profile "${profile.name}" (max_tokens ${maxTokens}, effort ${settings.reasoningEffort || 'default'})`);
        // Stream it: a non-streaming request runs to completion on the backend
        // even after the client aborts (the abort only lands at send time). A
        // streamed request dies the moment the connection drops — that's how
        // ST's own Stop button cancels KoboldCPP cleanly.
        const out = await ctx.ConnectionManagerRequestService.sendRequest(
            profile.id,
            messages,
            maxTokens,
            { stream: true, extractData: true, signal, includePreset: false, includeInstruct: false },
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
        log('request via main API (generateRaw)');
        return await ctx.generateRaw({
            prompt: userMsg || flat,
            systemPrompt: sysMsg,
            responseLength: maxTokens,
        });
    }

    if (typeof ctx.generateQuietPrompt === 'function') {
        log('request via main API (generateQuietPrompt)');
        return await ctx.generateQuietPrompt(flat, false, false);
    }

    throw new Error('no generation method available (no profile, no generateRaw/generateQuietPrompt)');
}
