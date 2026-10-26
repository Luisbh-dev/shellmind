import { afterEach, describe, expect, it } from 'vitest';
import type { ChatAttachment } from '@shared/chat';
import { attachmentName, defaultAskAiPrompt } from '@/components/AskAiButton';
import { attachmentLabel, describeEvidenceFailure, sectionTitle } from '@/features/chat/lib/evidence';
import { ApiError } from '@/lib/api';
import { setLanguage, t } from '@/i18n';
import { contextTabFor } from '@/store/appStore';

// W8-T2: a pod as the attachment of a diagnosis, in the chat's words.

const POD: ChatAttachment = { kind: 'pod', context: 'prod', namespace: 'shop', pod: 'api-7d9f-x2' };

afterEach(() => setLanguage('system'));

describe('pod attachments', () => {
    it('are named, labelled and asked about in English', () => {
        setLanguage('en');
        expect(attachmentName(POD)).toBe('api-7d9f-x2');
        expect(defaultAskAiPrompt(t, POD)).toBe('What is wrong with the pod api-7d9f-x2 in shop, and how do I fix it?');
        expect(attachmentLabel(t, POD)).toBe('Pod shop/api-7d9f-x2');
        expect(sectionTitle(t, { id: 'pod-logs' })).toBe('Container logs (last 200 lines)');
        expect(sectionTitle(t, { id: 'journal' })).not.toMatch(/^chat\./);
    });

    it('and in Spanish', () => {
        setLanguage('es');
        expect(defaultAskAiPrompt(t, POD)).toBe('¿Qué le pasa al pod api-7d9f-x2 de shop y cómo lo soluciono?');
        expect(sectionTitle(t, { id: 'pod-previous-logs' })).toBe('Logs de la instancia anterior');
    });

    it("open the server's Kubernetes tab", () => {
        expect(contextTabFor(POD)).toBe('kubernetes');
        expect(contextTabFor({ kind: 'status' })).toBe('status');
    });

    it("say why kubectl could not collect the evidence, in the user's language", () => {
        setLanguage('es');
        const message = 'error: You must be logged in to the server (Unauthorized)';
        const failure = describeEvidenceFailure(t, new ApiError(502, message, { error: message, code: 'K8S_AUTH_REQUIRED' }));
        expect(failure).toEqual({ title: 'El clúster pide que vuelvas a iniciar sesión.', details: [message] });
        // Other failures keep their shared wording.
        expect(describeEvidenceFailure(t, new ApiError(502, 'boom', { error: 'boom', code: 'SOMETHING_ELSE' })).title).toBe('boom');
    });
});
