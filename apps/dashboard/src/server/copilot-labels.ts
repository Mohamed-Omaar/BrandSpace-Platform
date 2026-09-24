import type { CopilotLabels } from '@brandspace/ui';
import { translator } from '../i18n/messages';

/**
 * THE COPILOT'S LABELS, in one place — the full Copilot screen and the global
 * drawer (D-277 §37) render the same conversation, so they say the same words.
 * Plain strings only: they cross to a client component.
 */
export function copilotLabels(locale: string, userName: string): CopilotLabels {
  const t = translator(locale);
  return {
    title: t('copilot.title'),
    subtitle: t('copilot.subtitle'),
    open: t('copilot.title'),
    close: t('common.close'),
    promptLabel: t('copilot.promptLabel'),
    promptPlaceholder: t('copilot.promptPlaceholder'),
    send: t('copilot.send'),
    attach: t('copilot.attach'),
    attachmentsLabel: t('copilot.attachments'),
    suggestionsLabel: t('copilot.suggestions'),
    conversationLabel: t('copilot.conversation'),
    streaming: t('copilot.working'),
    errorTitle: t('copilot.errorTitle'),
    errorBody: t('copilot.failed'),
    insufficientCreditsTitle: t('copilot.insufficientCreditsTitle'),
    insufficientCreditsBody: t('copilot.insufficientCreditsBody'),
    approvalTitle: t('copilot.plan'),
    approvalBody: t('copilot.approvalBody'),
    approve: t('copilot.confirm'),
    reject: t('copilot.reject'),
    mutatingWarning: t('copilot.externalWarning'),
    disabledNotice: t('copilot.composerAbove'),
    surfaceNames: {
      general: t('copilot.title'),
      calendar: t('nav.calendar'),
      posts: t('nav.content'),
      composer: t('nav.content'),
      studio: t('nav.content'),
    },
    contextLabel: t('copilot.contextLabel'),
    toolsLabel: t('copilot.steps'),
    previewTitle: t('copilot.plan'),
    beforeLabel: t('copilot.before'),
    afterLabel: t('copilot.after'),
    assistantName: t('copilot.title'),
    userName,
  };
}
